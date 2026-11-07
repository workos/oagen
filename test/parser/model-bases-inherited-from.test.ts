import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { validateModelRefs } from '../../src/parser/normalize-model-refs.js';
import { collapseJsonSuffixModels } from '../../src/parser/normalize-inline-models.js';
import {
  fieldAdmits,
  fieldPropertiesAdmit,
  modelAdmits,
  modelFingerprint,
  modelPropertiesAdmit,
} from '../../src/parser/inline-models.js';
import { collectReferencedNames } from '../../src/engine/generate-files.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Field, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #591: a model built from a component `allOf` of a `$ref` recorded
 * nothing about that component, so an emitter could not write `Pet` as
 * `Animal & { nickname?: string }` and repeated every field of `Animal`.
 * `Model.bases` now names the components the `allOf` names, one per `$ref`
 * member in document order, and `Field.inheritedFrom` the direct base a
 * field is taken from unchanged; `fields` stays complete and in order.
 */

const R = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string: TypeRef = { kind: 'primitive', type: 'string' };
const model = (name: string): TypeRef => ({ kind: 'model', name });
const ANIMAL = model('Animal');

const getting = (operationId: string, param: string, ref: string) => ({
  get: {
    operationId,
    parameters: [{ name: param, in: 'path', required: true, schema: { type: 'string' } }],
    responses: { '200': { description: 'ok', content: { 'application/json': { schema: R(ref) } } } },
  },
});
/** The issue's operations: `getAnimal` returning `Animal` and `getPet` returning `Pet`. */
const issuePaths = {
  '/animals/{animalId}': getting('getAnimal', 'animalId', 'Animal'),
  '/pets/{petId}': getting('getPet', 'petId', 'Pet'),
};

function documentWith(openapi: string, schemas: Record<string, unknown>, paths: Record<string, unknown> = issuePaths) {
  return { openapi, info: { title: 'repro', version: '1' }, paths, components: { schemas } };
}

const nameProperty = { type: 'string', description: 'The name the animal answers to.' };
/** The issue's `Animal`: `name` required. */
const animal = { type: 'object', required: ['name'], properties: { name: nameProperty } };
/** `overrides.json`'s `Animal`: `name` and `species` optional. */
const looseAnimal = { type: 'object', properties: { name: nameProperty, species: { type: 'string' } } };
const nickname = { type: 'string' };

/** `repro.json`: `Pet` writes `nickname` beside the `allOf`. */
const repro = { Animal: animal, Pet: { allOf: [R('Animal')], properties: { nickname } } };
/** `members.json`: `Pet` writes `nickname` in an inline member. */
const members = { Animal: animal, Pet: { allOf: [R('Animal'), { type: 'object', properties: { nickname } }] } };
/** `overrides.json`: `Pet` requires and narrows `name`, takes `species` as it is and adds `nickname`. */
const overrides = {
  Animal: looseAnimal,
  Pet: {
    allOf: [R('Animal')],
    required: ['name'],
    properties: { name: { type: 'string', enum: ['rex', 'max'], description: "The pet's registered name." }, nickname },
  },
};
const owned = { type: 'object', properties: { ownerId: { type: 'string' } } };
const living = { type: 'object', properties: { born: { type: 'string' } } };
/** `Pet` over an `Animal` that itself inherits `born` from `Living`. */
const nested = {
  Living: living,
  Animal: { allOf: [R('Living')], required: ['name'], properties: { name: nameProperty } },
  Pet: { allOf: [R('Animal')], properties: { nickname } },
};

const refName = (ref: TypeRef | undefined): string | undefined => (ref?.kind === 'model' ? ref.name : undefined);
/** `[name, required, base]` of each field, in order. */
const outline = (m: Model) => m.fields.map((f) => [f.name, f.required, refName(f.inheritedFrom)]);
const baseNames = (m: Model) => m.bases?.map(refName);
const keysOf = (m: Model) =>
  Object.keys(m).filter((key) => (m as unknown as Record<string, unknown>)[key] !== undefined);

describe('#591', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-bases-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  let counter = 0;
  async function parseJson(doc: unknown): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, `spec-${counter++}.json`);
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return parseSpec(specFile);
  }

  function modelNamed(spec: ApiSpec, name: string): Model {
    const found = spec.models.find((m) => m.name === name);
    if (!found) throw new Error(`no model ${name} among ${spec.models.map((m) => m.name).join(', ')}`);
    return found;
  }

  const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

  for (const openapi of ['3.1.0', '3.0.3']) {
    /** `{ type, nullable }` as the version spells it. */
    const nullable = (type: string) => (openapi === '3.0.3' ? { type, nullable: true } : { type: [type, 'null'] });

    describe(`on OAS ${openapi}`, () => {
      it('repro.json: Pet names Animal as its base and takes name from it, nickname its own', async () => {
        const spec = await parseJson(documentWith(openapi, repro));
        const pet = modelNamed(spec, 'Pet');
        expect(pet.bases).toEqual([ANIMAL]);
        expect(keysOf(pet)).toEqual(['name', 'fields', 'bases']);
        expect(pet.fields).toEqual([
          { name: 'nickname', type: string, required: false },
          {
            name: 'name',
            type: string,
            required: true,
            description: 'The name the animal answers to.',
            inheritedFrom: ANIMAL,
          },
        ]);
        const base = modelNamed(spec, 'Animal');
        expect(base.bases).toBeUndefined();
        expect(base.fields.map((f) => f.inheritedFrom)).toEqual([undefined]);
        expect(warnings()).toEqual([]);
      });

      it('members.json: the inline member keeps the field order, name first', async () => {
        const spec = await parseJson(documentWith(openapi, members));
        const pet = modelNamed(spec, 'Pet');
        expect(baseNames(pet)).toEqual(['Animal']);
        expect(outline(pet)).toEqual([
          ['name', true, 'Animal'],
          ['nickname', false, undefined],
        ]);
        expect(keysOf(pet)).toEqual(['name', 'fields', 'bases']);
      });

      it('overrides.json: name (required, narrowed) and nickname are Pet’s own, species is Animal’s', async () => {
        const spec = await parseJson(documentWith(openapi, overrides));
        const pet = modelNamed(spec, 'Pet');
        expect(pet.bases).toEqual([ANIMAL]);
        expect(outline(pet)).toEqual([
          ['name', true, undefined],
          ['nickname', false, undefined],
          ['species', false, 'Animal'],
        ]);
        expect(pet.fields[0]).toMatchObject({
          name: 'name',
          type: { kind: 'enum', name: 'PetName' },
          required: true,
          description: "The pet's registered name.",
        });
        expect(pet.fields[0]!.inheritedFrom).toBeUndefined();
        expect(pet.fields[2]).toEqual({ name: 'species', type: string, required: false, inheritedFrom: ANIMAL });
        expect(outline(modelNamed(spec, 'Animal'))).toEqual([
          ['name', false, undefined],
          ['species', false, undefined],
        ]);
      });

      it('two bases: one entry per $ref member, in document order, each field naming its own', async () => {
        const twoBases = {
          Animal: animal,
          Owned: owned,
          Pet: { allOf: [R('Animal'), R('Owned')], properties: { nickname } },
        };
        const pet = modelNamed(await parseJson(documentWith(openapi, twoBases)), 'Pet');
        expect(pet.bases).toEqual([ANIMAL, model('Owned')]);
        expect(outline(pet)).toEqual([
          ['nickname', false, undefined],
          ['name', true, 'Animal'],
          ['ownerId', false, 'Owned'],
        ]);
        // The other order: the bases and the fields follow the document.
        const swapped = { ...twoBases, Pet: { allOf: [R('Owned'), R('Animal')], properties: { nickname } } };
        const swappedPet = modelNamed(await parseJson(documentWith(openapi, swapped)), 'Pet');
        expect(baseNames(swappedPet)).toEqual(['Owned', 'Animal']);
        expect(outline(swappedPet)).toEqual([
          ['nickname', false, undefined],
          ['ownerId', false, 'Owned'],
          ['name', true, 'Animal'],
        ]);
      });

      it('nested base: each model names its direct base only, and a field inherited in turn names it', async () => {
        const spec = await parseJson(documentWith(openapi, nested));
        expect(modelNamed(spec, 'Living').bases).toBeUndefined();
        const base = modelNamed(spec, 'Animal');
        expect(base.bases).toEqual([model('Living')]);
        expect(outline(base)).toEqual([
          ['name', true, undefined],
          ['born', false, 'Living'],
        ]);
        const pet = modelNamed(spec, 'Pet');
        expect(pet.bases).toEqual([ANIMAL]);
        expect(outline(pet)).toEqual([
          ['nickname', false, undefined],
          ['name', true, 'Animal'],
          ['born', false, 'Animal'],
        ]);
      });

      it('a required the base does not declare makes the field the model’s own; one it already declares changes nothing', async () => {
        const requiring = (over: Record<string, unknown>) =>
          parseJson(
            documentWith(openapi, {
              Animal: looseAnimal,
              Pet: { allOf: [R('Animal')], properties: { nickname }, ...over },
            }),
          );
        // `required: [species]` beside the `allOf`, over an optional `species`.
        expect(outline(modelNamed(await requiring({ required: ['species'] }), 'Pet'))).toEqual([
          ['nickname', false, undefined],
          ['name', false, 'Animal'],
          ['species', true, undefined],
        ]);
        // The same list in an inline member after the `$ref`.
        const member = {
          Animal: looseAnimal,
          Pet: { allOf: [R('Animal'), { required: ['species'] }], properties: { nickname } },
        };
        expect(outline(modelNamed(await parseJson(documentWith(openapi, member)), 'Pet'))).toEqual([
          ['nickname', false, undefined],
          ['name', false, 'Animal'],
          ['species', true, undefined],
        ]);
        // `required: [name]` over a base that already requires `name`.
        const again = { Animal: animal, Pet: { allOf: [R('Animal')], required: ['name'], properties: { nickname } } };
        expect(outline(modelNamed(await parseJson(documentWith(openapi, again)), 'Pet'))).toEqual([
          ['nickname', false, undefined],
          ['name', true, 'Animal'],
        ]);
      });

      it('a description, a deprecation or a nullability the model adds makes the field its own', async () => {
        const own = async (species: Record<string, unknown>, where: 'own' | 'member') => {
          const pet =
            where === 'own'
              ? { allOf: [R('Animal')], properties: { species, nickname } }
              : { allOf: [R('Animal'), { properties: { species } }], properties: { nickname } };
          const spec = await parseJson(documentWith(openapi, { Animal: looseAnimal, Pet: pet }));
          const field = modelNamed(spec, 'Pet').fields.find((f) => f.name === 'species') as Field;
          return { inheritedFrom: refName(field.inheritedFrom), field };
        };
        // A description the base has none of, beside the `allOf` and in a later member.
        expect(await own({ description: 'Which species.' }, 'own')).toMatchObject({
          inheritedFrom: undefined,
          field: { description: 'Which species.', type: string },
        });
        expect(await own({ description: 'Which species.' }, 'member')).toMatchObject({
          inheritedFrom: undefined,
          field: { description: 'Which species.', type: string },
        });
        // A flag or a nullability the model's own declaration adds.
        expect(await own({ type: 'string', deprecated: true }, 'own')).toMatchObject({
          inheritedFrom: undefined,
          field: { deprecated: true },
        });
        expect(await own(nullable('string'), 'own')).toMatchObject({
          inheritedFrom: undefined,
          field: { type: { kind: 'nullable', inner: string } },
        });
        // A later typing declaration the base's outranks is set aside by the
        // merge, so the field stays the base's as the IR carries it.
        expect(await own(nullable('string'), 'member')).toEqual({
          inheritedFrom: 'Animal',
          field: { name: 'species', type: string, required: false, inheritedFrom: ANIMAL },
        });
        // A description on a field the base already documents is set aside
        // the same way (the first typing declaration's text wins).
        const documented = {
          Animal: looseAnimal,
          Pet: { allOf: [R('Animal')], properties: { name: { description: 'Other.' }, nickname } },
        };
        const name = modelNamed(await parseJson(documentWith(openapi, documented)), 'Pet').fields[0] as Field;
        expect(name).toEqual({
          name: 'name',
          type: string,
          required: false,
          description: 'The name the animal answers to.',
          inheritedFrom: ANIMAL,
        });
      });

      it('a bare alias is a base of its own (#618); a nullable alias is read to the component it names; an allOf alias is a base of its own', async () => {
        const bare = { Animal: looseAnimal, Hop: R('Animal'), Pet: { allOf: [R('Hop')], properties: { nickname } } };
        const bareSpec = await parseJson(documentWith(openapi, bare));
        const hop = modelNamed(bareSpec, 'Hop');
        expect(hop.bases).toEqual([ANIMAL]);
        expect(outline(hop)).toEqual([
          ['name', false, 'Animal'],
          ['species', false, 'Animal'],
        ]);
        const barePet = modelNamed(bareSpec, 'Pet');
        expect(barePet.bases).toEqual([model('Hop')]);
        expect(outline(barePet)).toEqual([
          ['nickname', false, undefined],
          ['name', false, 'Hop'],
          ['species', false, 'Hop'],
        ]);
        if (openapi === '3.1.0') {
          const alias = {
            Animal: looseAnimal,
            Alias: { oneOf: [R('Animal'), { type: 'null' }] },
            Pet: { allOf: [R('Alias')], properties: { nickname } },
          };
          const aliasPet = modelNamed(await parseJson(documentWith(openapi, alias)), 'Pet');
          expect(aliasPet.bases).toEqual([ANIMAL]);
          expect(outline(aliasPet)).toEqual([
            ['nickname', false, undefined],
            ['name', false, 'Animal'],
            ['species', false, 'Animal'],
          ]);
        }
        const composed = {
          Animal: looseAnimal,
          Hop: { allOf: [R('Animal')] },
          Pet: { allOf: [R('Hop')], properties: { nickname } },
        };
        const spec = await parseJson(documentWith(openapi, composed));
        expect(modelNamed(spec, 'Hop').bases).toEqual([ANIMAL]);
        expect(outline(modelNamed(spec, 'Hop'))).toEqual([
          ['name', false, 'Animal'],
          ['species', false, 'Animal'],
        ]);
        const pet = modelNamed(spec, 'Pet');
        expect(pet.bases).toEqual([model('Hop')]);
        expect(outline(pet)).toEqual([
          ['nickname', false, undefined],
          ['name', false, 'Hop'],
          ['species', false, 'Hop'],
        ]);
        // A bare alias of a nullable alias is a model of its own (#618), and the
        // base: what the wrapper's one variant names is the alias's (Greptile).
        if (openapi === '3.1.0') {
          const over = {
            Animal: looseAnimal,
            Alias: { oneOf: [R('Animal'), { type: 'null' }] },
            Hop: R('Alias'),
            Pet: { allOf: [R('Hop')], properties: { nickname } },
          };
          const overSpec = await parseJson(documentWith(openapi, over));
          expect(modelNamed(overSpec, 'Hop').bases).toEqual([ANIMAL]);
          const overPet = modelNamed(overSpec, 'Pet');
          expect(overPet.bases).toEqual([model('Hop')]);
          expect(outline(overPet)).toEqual([
            ['nickname', false, undefined],
            ['name', false, 'Hop'],
            ['species', false, 'Hop'],
          ]);
        }
        // A two-hop bare chain: each model names the next.
        const hops = {
          Animal: looseAnimal,
          Hop2: R('Animal'),
          Hop: R('Hop2'),
          Pet: { allOf: [R('Hop')], properties: { nickname } },
        };
        const hopsSpec = await parseJson(documentWith(openapi, hops));
        expect(modelNamed(hopsSpec, 'Hop2').bases).toEqual([ANIMAL]);
        expect(modelNamed(hopsSpec, 'Hop').bases).toEqual([model('Hop2')]);
        expect(modelNamed(hopsSpec, 'Pet').bases).toEqual([model('Hop')]);
        expect(outline(modelNamed(hopsSpec, 'Pet'))).toEqual([
          ['nickname', false, undefined],
          ['name', false, 'Hop'],
          ['species', false, 'Hop'],
        ]);
        // A bare alias of an `allOf` component: each model names the next.
        const chain = { ...nested, Hop: R('Animal'), Pet: { allOf: [R('Hop')], properties: { nickname } } };
        const chainSpec = await parseJson(documentWith(openapi, chain));
        expect(modelNamed(chainSpec, 'Animal').bases).toEqual([model('Living')]);
        expect(modelNamed(chainSpec, 'Hop').bases).toEqual([ANIMAL]);
        expect(outline(modelNamed(chainSpec, 'Hop'))).toEqual([
          ['name', true, 'Animal'],
          ['born', false, 'Animal'],
        ]);
        const chainPet = modelNamed(chainSpec, 'Pet');
        expect(chainPet.bases).toEqual([model('Hop')]);
        expect(outline(chainPet)).toEqual([
          ['nickname', false, undefined],
          ['name', true, 'Hop'],
          ['born', false, 'Hop'],
        ]);
      });

      it('a $ref member naming an enum, array or primitive component is no base and contributes nothing, as before', async () => {
        const schemas = {
          Animal: looseAnimal,
          Kind: { type: 'string', enum: ['cat', 'dog'] },
          Tags: { type: 'array', items: { type: 'string' } },
          Id: { type: 'string', format: 'uuid' },
          Pet: { allOf: [R('Animal'), R('Kind'), R('Tags'), R('Id')], properties: { nickname } },
        };
        const spec = await parseJson(documentWith(openapi, schemas));
        const pet = modelNamed(spec, 'Pet');
        expect(pet.bases).toEqual([ANIMAL]);
        expect(outline(pet)).toEqual([
          ['nickname', false, undefined],
          ['name', false, 'Animal'],
          ['species', false, 'Animal'],
        ]);
        expect(spec.enums.map((e) => e.name)).toEqual(['Kind']);
      });

      it('a $ref member naming a named union is a base, its flattened fields the model’s own; a dispatched one too', async () => {
        const flattened = {
          Animal: looseAnimal,
          Home: {
            oneOf: [
              { type: 'object', properties: { ownerId: { type: 'string' } } },
              { type: 'object', properties: { shelterId: { type: 'string' } } },
            ],
          },
          Pet: { allOf: [R('Animal'), R('Home')], properties: { nickname } },
        };
        const pet = modelNamed(await parseJson(documentWith(openapi, flattened)), 'Pet');
        expect(baseNames(pet)).toEqual(['Animal', 'Home']);
        expect(outline(pet)).toEqual([
          ['nickname', false, undefined],
          ['name', false, 'Animal'],
          ['species', false, 'Animal'],
          ['ownerId', false, undefined],
          ['shelterId', false, undefined],
        ]);
        const dispatched = {
          Animal: looseAnimal,
          Cat: { type: 'object', properties: { kind: { const: 'cat' }, meow: { type: 'string' } } },
          Dog: { type: 'object', properties: { kind: { const: 'dog' }, bark: { type: 'string' } } },
          Home: { oneOf: [R('Cat'), R('Dog')] },
          Pet: { allOf: [R('Animal'), R('Home')], properties: { nickname } },
        };
        const dispatcher = modelNamed(await parseJson(documentWith(openapi, dispatched)), 'Pet');
        expect(baseNames(dispatcher)).toEqual(['Animal', 'Home']);
        expect(dispatcher.discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } });
        expect(outline(dispatcher)).toEqual([
          ['nickname', false, undefined],
          ['name', false, 'Animal'],
          ['species', false, 'Animal'],
        ]);
      });

      it('a base’s own flattened union leaves its variants’ fields the model’s own', async () => {
        const schemas = {
          Animal: {
            type: 'object',
            properties: { name: { type: 'string' } },
            oneOf: [
              { type: 'object', properties: { ownerId: { type: 'string' } } },
              { type: 'object', properties: { shelterId: { type: 'string' } } },
            ],
          },
          Pet: { allOf: [R('Animal')], properties: { nickname } },
        };
        const pet = modelNamed(await parseJson(documentWith(openapi, schemas)), 'Pet');
        expect(pet.bases).toEqual([ANIMAL]);
        expect(outline(pet)).toEqual([
          ['nickname', false, undefined],
          ['name', false, 'Animal'],
          ['ownerId', false, undefined],
          ['shelterId', false, undefined],
        ]);
      });

      it('an inline object the base declares is inherited, its type still built under the inheriting model’s name', async () => {
        const meta = { type: 'object', properties: { a: { type: 'string' } } };
        const schemas = {
          Animal: { ...looseAnimal, properties: { ...looseAnimal.properties, meta } },
          Pet: { allOf: [R('Animal')], properties: { nickname } },
        };
        const spec = await parseJson(documentWith(openapi, schemas));
        const field = modelNamed(spec, 'Pet').fields.find((f) => f.name === 'meta') as Field;
        expect(field).toEqual({ name: 'meta', type: model('PetMeta'), required: false, inheritedFrom: ANIMAL });
        expect(modelNamed(spec, 'Animal').fields.find((f) => f.name === 'meta')?.type).toEqual(model('AnimalMeta'));
        expect(modelNamed(spec, 'PetMeta').fields).toEqual(modelNamed(spec, 'AnimalMeta').fields);
      });

      it('a member read again — the same $ref twice, or the component itself, or an alias of it — is no further base', async () => {
        const twice = { Animal: looseAnimal, Pet: { allOf: [R('Animal'), R('Animal')], properties: { nickname } } };
        expect(modelNamed(await parseJson(documentWith(openapi, twice)), 'Pet').bases).toEqual([ANIMAL]);
        const self = { Animal: looseAnimal, Pet: { allOf: [R('Animal'), R('Pet')], properties: { nickname } } };
        const pet = modelNamed(await parseJson(documentWith(openapi, self)), 'Pet');
        expect(pet.bases).toEqual([ANIMAL]);
        expect(outline(pet)).toEqual([
          ['nickname', false, undefined],
          ['name', false, 'Animal'],
          ['species', false, 'Animal'],
        ]);
        const viaAlias = {
          Animal: looseAnimal,
          Hop: R('Pet'),
          Pet: { allOf: [R('Animal'), R('Hop')], properties: { nickname } },
        };
        expect(modelNamed(await parseJson(documentWith(openapi, viaAlias)), 'Pet').bases).toEqual([ANIMAL]);
      });

      it('a direct $ref member another member’s chain already read is still a base, in either order (Greptile)', async () => {
        const chain = {
          Born: { type: 'object', properties: { born: { type: 'string' } } },
          Living: { allOf: [R('Born')], properties: { alive: { type: 'boolean' } } },
          Animal: { allOf: [R('Living')], required: ['name'], properties: { name: nameProperty } },
        };
        const first = { ...chain, Pet: { allOf: [R('Animal'), R('Living')], properties: { nickname } } };
        const pet = modelNamed(await parseJson(documentWith(openapi, first)), 'Pet');
        expect(pet.bases).toEqual([ANIMAL, model('Living')]);
        expect(outline(pet)).toEqual([
          ['nickname', false, undefined],
          ['name', true, 'Animal'],
          ['alive', false, 'Animal'],
          ['born', false, 'Animal'],
        ]);
        const reordered = { ...chain, Pet: { allOf: [R('Living'), R('Animal')], properties: { nickname } } };
        const swapped = modelNamed(await parseJson(documentWith(openapi, reordered)), 'Pet');
        expect(swapped.bases).toEqual([model('Living'), ANIMAL]);
        expect(outline(swapped)).toEqual([
          ['nickname', false, undefined],
          ['alive', false, 'Living'],
          ['born', false, 'Living'],
          ['name', true, 'Animal'],
        ]);
      });

      it('an allOf+oneOf dispatcher names its base; its variant models carry neither key, and a component of a variant’s shape still stands for it', async () => {
        const kindCat = { kind: { const: 'cat' }, meow: { type: 'string' } };
        const schemas = {
          Base: { type: 'object', properties: { id: { type: 'string' } } },
          PetCat: { allOf: [R('Base')], properties: kindCat },
          Pet: {
            allOf: [
              R('Base'),
              {
                oneOf: [
                  { type: 'object', properties: kindCat },
                  { type: 'object', properties: { kind: { const: 'dog' }, bark: { type: 'string' } } },
                ],
              },
            ],
          },
        };
        const spec = await parseJson(
          documentWith(openapi, schemas, { '/pets/{petId}': getting('getPet', 'petId', 'Pet') }),
        );
        const pet = modelNamed(spec, 'Pet');
        expect(pet.bases).toEqual([model('Base')]);
        expect(pet.discriminator).toEqual({ property: 'kind', mapping: { cat: 'PetCat', dog: 'PetDog' } });
        expect(outline(pet)).toEqual([['id', false, 'Base']]);
        // The component `PetCat` stands for the `cat` variant, as it did
        // before it carried `bases`: the keys are outside the shape.
        expect(spec.models.filter((m) => m.name.startsWith('PetCat')).map((m) => m.name)).toEqual(['PetCat']);
        expect(modelNamed(spec, 'PetCat').bases).toEqual([model('Base')]);
        const dog = modelNamed(spec, 'PetDog');
        expect(dog.bases).toBeUndefined();
        expect(dog.fields.every((f) => f.inheritedFrom === undefined)).toBe(true);
      });

      it('a `<Name>Json` component built on a base folds onto `<Name>` with its bases and each field’s origin (Greptile)', async () => {
        const schemas = {
          Animal: animal,
          Pet: { type: 'object', properties: { id: { type: 'string' } } },
          PetJson: { allOf: [R('Animal')], properties: { id: { type: 'string' }, extra: { type: 'string' } } },
        };
        const paths = { ...issuePaths, '/pets/{petId}/json': getting('getPetJson', 'petId', 'PetJson') };
        const spec = await parseJson(documentWith(openapi, schemas, paths));
        expect(spec.models.map((m) => m.name)).toEqual(['Animal', 'Pet']);
        const pet = modelNamed(spec, 'Pet');
        expect(pet.bases).toEqual([ANIMAL]);
        expect(outline(pet)).toEqual([
          ['id', false, undefined],
          ['extra', false, undefined],
          ['name', true, 'Animal'],
        ]);
        expect(collectReferencedNames(spec.services, spec.models).models.has('Animal')).toBe(true);
        // `PetJson` built on `Pet` itself: the fold drops that base, and the
        // fields it lent are `Pet`'s own.
        const onSelf = {
          Pet: { type: 'object', properties: { id: { type: 'string' } } },
          PetJson: { allOf: [R('Pet')], properties: { extra: { type: 'string' } } },
        };
        const selfSpec = await parseJson(
          documentWith(openapi, onSelf, {
            '/pets/{petId}': getting('getPet', 'petId', 'Pet'),
            '/pets/{petId}/json': getting('getPetJson', 'petId', 'PetJson'),
          }),
        );
        expect(selfSpec.models.map((m) => m.name)).toEqual(['Pet']);
        expect(modelNamed(selfSpec, 'Pet').bases).toBeUndefined();
        expect(outline(modelNamed(selfSpec, 'Pet'))).toEqual([
          ['extra', false, undefined],
          ['id', false, undefined],
        ]);
        // `PetJson` built on `Animal`, itself built on `Pet`: the fold would
        // make `Pet` extend a model that extends it, so that base is dropped
        // and `Animal` keeps its own (Greptile, round two).
        const cyclic = {
          Pet: { type: 'object', properties: { id: { type: 'string' } } },
          Animal: { allOf: [R('Pet')], properties: { name: { type: 'string' } } },
          PetJson: { allOf: [R('Animal')], properties: { extra: { type: 'string' } } },
        };
        const cyclicSpec = await parseJson(
          documentWith(openapi, cyclic, {
            ...issuePaths,
            '/pets/{petId}/json': getting('getPetJson', 'petId', 'PetJson'),
          }),
        );
        expect(cyclicSpec.models.map((m) => m.name)).toEqual(['Pet', 'Animal']);
        expect(modelNamed(cyclicSpec, 'Pet').bases).toBeUndefined();
        expect(outline(modelNamed(cyclicSpec, 'Pet'))).toEqual([
          ['extra', false, undefined],
          ['name', false, undefined],
          ['id', false, undefined],
        ]);
        expect(modelNamed(cyclicSpec, 'Animal').bases).toEqual([model('Pet')]);
        expect(outline(modelNamed(cyclicSpec, 'Animal'))).toEqual([
          ['name', false, undefined],
          ['id', false, 'Pet'],
        ]);
      });

      it('a model built from an inline allOf — a body, a field — carries neither key', async () => {
        const merged = { allOf: [R('Animal'), { type: 'object', properties: { nickname } }] };
        const paths = {
          ...issuePaths,
          '/pets': {
            post: {
              operationId: 'createPet',
              requestBody: { content: { 'application/json': { schema: merged } } },
              responses: { '200': { description: 'ok', content: { 'application/json': { schema: R('Pet') } } } },
            },
          },
        };
        const schemas = { ...repro, Holder: { type: 'object', properties: { pet: merged } } };
        const spec = await parseJson(documentWith(openapi, schemas, paths));
        for (const name of ['CreatePetRequest', 'HolderPet']) {
          const m = modelNamed(spec, name);
          expect(
            m.fields.map((f) => f.name),
            name,
          ).toEqual(['name', 'nickname']);
          expect(m.bases, name).toBeUndefined();
          expect(
            m.fields.map((f) => f.inheritedFrom),
            name,
          ).toEqual([undefined, undefined]);
        }
        expect(modelNamed(spec, 'Pet').bases).toEqual([ANIMAL]);
      });

      it('oagen diff sees nothing between a Pet that declares name itself and one that inherits it', async () => {
        const declares = {
          Animal: animal,
          Pet: { type: 'object', required: ['name'], properties: { nickname, name: nameProperty } },
        };
        const own = await parseJson(documentWith(openapi, declares));
        const inherits = await parseJson(documentWith(openapi, repro));
        expect(modelNamed(own, 'Pet').bases).toBeUndefined();
        expect(modelNamed(inherits, 'Pet').bases).toEqual([ANIMAL]);
        for (const report of [diffSpecs(own, inherits), diffSpecs(inherits, own)]) {
          expect(report.changes).toEqual([]);
          expect(report.behaviorChanges).toEqual([]);
        }
      });

      it('a base no operation reaches is still reachable for emission through the model built on it', async () => {
        const spec = await parseJson(
          documentWith(openapi, repro, { '/pets/{petId}': getting('getPet', 'petId', 'Pet') }),
        );
        expect(spec.models.map((m) => m.name)).toEqual(['Animal', 'Pet']);
        expect(collectReferencedNames(spec.services, spec.models).models.has('Animal')).toBe(true);
        expect(
          collectReferencedNames(spec.services, spec.models, { preserveAllDiscriminated: false }).models.has('Animal'),
        ).toBe(true);
        expect(warnings()).toEqual([]);
      });
    });
  }

  describe('the `…Json` fold (Greptile)', () => {
    const field = (name: string, extra: Partial<Field> = {}): Field => ({
      name,
      type: string,
      required: false,
      ...extra,
    });

    it('carries the `…Json` model’s bases and each field’s origin onto the base it folds into', () => {
      const models: Model[] = [
        { name: 'Animal', fields: [field('name')] },
        { name: 'Pet', fields: [field('id')] },
        {
          name: 'PetJson',
          fields: [field('id'), field('extra'), field('name', { inheritedFrom: ANIMAL })],
          bases: [ANIMAL],
        },
      ];
      const merged = collapseJsonSuffixModels(models, []);
      expect(merged.map((m) => m.name)).toEqual(['Animal', 'Pet']);
      expect(merged[1]!.bases).toEqual([ANIMAL]);
      expect(outline(merged[1]!)).toEqual([
        ['id', false, undefined],
        ['extra', false, undefined],
        ['name', false, 'Animal'],
      ]);
    });

    it('drops a base that is the folded model itself, by either name, and makes the fields it lent the model’s own', () => {
      for (const self of ['Pet', 'PetJson']) {
        const models: Model[] = [
          { name: 'Pet', fields: [field('id')] },
          {
            name: 'PetJson',
            fields: [field('id', { inheritedFrom: model(self) }), field('extra')],
            bases: [model(self)],
          },
        ];
        const merged = collapseJsonSuffixModels(models, []);
        expect(
          merged.map((m) => m.name),
          self,
        ).toEqual(['Pet']);
        expect(merged[0]!.bases, self).toBeUndefined();
        expect(outline(merged[0]!), self).toEqual([
          ['id', false, undefined],
          ['extra', false, undefined],
        ]);
      }
    });

    it('drops a base whose own chain reaches the folded model, so a fold never closes a cycle (Greptile, round two)', () => {
      const models: Model[] = [
        { name: 'Pet', fields: [field('id')] },
        {
          name: 'Animal',
          fields: [field('name'), field('id', { inheritedFrom: model('Pet') })],
          bases: [model('Pet')],
        },
        {
          name: 'PetJson',
          fields: [field('extra'), field('name', { inheritedFrom: ANIMAL }), field('id', { inheritedFrom: ANIMAL })],
          bases: [ANIMAL],
        },
      ];
      const merged = collapseJsonSuffixModels(models, []);
      expect(merged.map((m) => m.name)).toEqual(['Pet', 'Animal']);
      expect(merged[0]!.bases).toBeUndefined();
      expect(outline(merged[0]!)).toEqual([
        ['extra', false, undefined],
        ['name', false, undefined],
        ['id', false, undefined],
      ]);
      expect(merged[1]!.bases).toEqual([model('Pet')]);
    });

    it('leaves the base’s own bases behind when a plain `…Json` model folds onto it, as it leaves its variants', () => {
      const models: Model[] = [
        { name: 'Animal', fields: [field('name')] },
        { name: 'Pet', fields: [field('name', { inheritedFrom: ANIMAL })], bases: [ANIMAL] },
        { name: 'PetJson', fields: [field('name'), field('extra')] },
      ];
      const merged = collapseJsonSuffixModels(models, []);
      expect(merged.map((m) => m.name)).toEqual(['Animal', 'Pet']);
      expect(merged[1]!.bases).toBeUndefined();
      expect(outline(merged[1]!)).toEqual([
        ['name', false, undefined],
        ['extra', false, undefined],
      ]);
    });
  });

  describe('the keys are provenance, not shape', () => {
    const plain: Field = { name: 'name', type: string, required: true };
    const inherited: Field = { ...plain, inheritedFrom: ANIMAL };
    const petPlain: Model = { name: 'Pet', fields: [plain] };
    const petBased: Model = { name: 'Pet', fields: [inherited], bases: [ANIMAL] };

    it('every admit predicate and the fingerprint read a field and a model with and without them alike', () => {
      expect(fieldAdmits(plain, inherited)).toBe(true);
      expect(fieldAdmits(inherited, plain)).toBe(true);
      expect(fieldPropertiesAdmit(plain, inherited)).toBe(true);
      expect(fieldPropertiesAdmit(inherited, plain)).toBe(true);
      expect(modelAdmits(petPlain, petBased)).toBe(true);
      expect(modelAdmits(petBased, petPlain)).toBe(true);
      expect(modelPropertiesAdmit(petPlain, petBased)).toBe(true);
      expect(modelPropertiesAdmit(petBased, petPlain)).toBe(true);
      expect(modelFingerprint(petBased)).toBe(modelFingerprint(petPlain));
    });

    it('validateModelRefs warns for a base or an inheritedFrom naming no model', () => {
      const spec: ApiSpec = {
        name: 'r',
        version: '1',
        baseUrl: 'https://example.test',
        services: [],
        models: [{ name: 'Pet', fields: [{ ...plain, inheritedFrom: model('Ghost') }], bases: [model('Ghost')] }],
        enums: [],
        sdk: defaultSdkBehavior(),
      };
      validateModelRefs(spec);
      expect(warnings()).toEqual([
        '[oagen] Warning: Unresolved model reference "Ghost" (context: Pet.name.inheritedFrom)',
        '[oagen] Warning: Unresolved model reference "Ghost" (context: Pet.bases)',
      ]);
    });
  });
});
