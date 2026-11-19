import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Field, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #713: `check-emitter-parity` listed "a parent class" beside
 * `extends` and an intersection and said a field the model declares over a
 * base's fits it, "so the extension compiles". The fit that keeps a base
 * (#681) is read by the values a type admits — how TypeScript types
 * `interface … extends` and an intersection — so `integer` under `number`
 * and an enum under `string` keep the base, and a language whose member
 * types are nominal takes neither as an override.
 *
 * The parser is as it was. These tests pin the documents the docs now
 * name and what they tell an emitter that writes a parent class to read:
 * a declaration of the model's own over a base's carries no mark of its
 * own, and is found by name among the `fields` of the base's model.
 */

const R = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** The issue's operation: `GET /pets` (`listPets`) returning `Pet`. */
const issuePaths = {
  '/pets': {
    get: {
      operationId: 'listPets',
      responses: { '200': { description: 'OK', content: { 'application/json': { schema: R('Pet') } } } },
    },
  },
};

function documentWith(openapi: string, schemas: Record<string, unknown>) {
  return { openapi, info: { title: 'Repro 713', version: '1.0.0' }, paths: issuePaths, components: { schemas } };
}

const typeText = (type: TypeRef): string => {
  switch (type.kind) {
    case 'primitive':
      return type.format ? `${type.type}(${type.format})` : type.type;
    case 'literal':
      return JSON.stringify(type.value);
    case 'enum':
    case 'model':
      return type.name;
    case 'array':
      return `${typeText(type.items)}[]`;
    case 'nullable':
      return `${typeText(type.inner)} | null`;
    case 'map':
      return `{ [key]: ${typeText(type.valueType)} }`;
    case 'union':
      return type.variants.map(typeText).join(' | ');
  }
};
const refName = (ref: TypeRef | undefined): string | undefined => (ref?.kind === 'model' ? ref.name : undefined);
/** A field as the issue's script prints it: `name?: type <- Base`. */
const show = ({ inheritedFrom, name, required, type }: Field) =>
  `${name}${required ? '' : '?'}: ${typeText(type)}${inheritedFrom ? ` <- ${refName(inheritedFrom)}` : ''}`;
/** A model as the issue's script prints it: `Name : Base & Base { fields }`. */
const print = ({ bases, fields, name }: Model) =>
  `${name}${bases ? ` : ${bases.map(refName).join(' & ')}` : ''} { ${fields.map(show).join(', ')} }`;

/**
 * What the docs tell an emitter that writes a parent class to do: each
 * field of `model` without `inheritedFrom`, looked up by name among the
 * `fields` of each base's model, with the base's declaration when it has
 * one.
 */
function declaredOverBase(model: Model, spec: ApiSpec): string[] {
  const found: string[] = [];
  for (const field of model.fields) {
    if (field.inheritedFrom) continue;
    for (const base of model.bases ?? []) {
      const declared = spec.models
        .find((candidate) => candidate.name === refName(base))
        ?.fields.find((candidate) => candidate.name === field.name);
      if (declared) found.push(`${show(field)} over ${refName(base)} { ${show(declared)} }`);
    }
  }
  return found;
}

describe('#713 a base’s fit is by the values a type admits, which a parent class has to check itself', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-parent-class-'));
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

  const kindEnum = { type: 'string', enum: ['cat', 'dog'] };
  /** `weight.json`: `Animal { weight?: number }` under a `Pet` that declares `weight` an integer. */
  const weight = {
    Animal: { type: 'object', properties: { weight: { type: 'number' } } },
    Pet: { allOf: [R('Animal')], properties: { weight: { type: 'integer' } } },
  };
  /** `species.json`: `Animal { species?: string }` under a `Pet` that declares `species` an enum. */
  const species = {
    Animal: { type: 'object', properties: { species: { type: 'string' } } },
    Pet: { allOf: [R('Animal')], properties: { species: kindEnum } },
  };

  for (const openapi of ['3.1.0', '3.0.3']) {
    /** `{ type, nullable }` as the version spells it. */
    const nullable = (schema: Record<string, unknown>) =>
      openapi === '3.0.3' ? { ...schema, nullable: true } : { ...schema, type: [schema.type, 'null'] };
    /** One pinned value as the version spells it. */
    const pinned = (value: string) => (openapi === '3.0.3' ? { type: 'string', enum: [value] } : { const: value });
    const parsed = async (schemas: Record<string, unknown>) => parseJson(documentWith(openapi, schemas));

    describe(`on OAS ${openapi}`, () => {
      it('the issue’s documents: an integer under a number and an enum under a string keep the base', async () => {
        // The issue's script, which prints a type by its name or its primitive.
        const issueShow = ({ inheritedFrom, name, required, type }: Field) =>
          `${name}${required ? '' : '?'}: ${'name' in type ? type.name : 'type' in type ? type.type : type.kind}${
            inheritedFrom ? ` <- ${refName(inheritedFrom)}` : ''
          }`;
        const issuePrint = ({ bases, fields, name }: Model) =>
          `${name}${bases ? ` : ${bases.map(refName).join(' & ')}` : ''} { ${fields.map(issueShow).join(', ')} }`;
        expect((await parsed(weight)).models.map(issuePrint)).toEqual([
          'Animal { weight?: number }',
          'Pet : Animal { weight?: integer }',
        ]);
        expect((await parsed(species)).models.map(issuePrint)).toEqual([
          'Animal { species?: string }',
          'Pet : Animal { species?: PetSpecies }',
        ]);
        expect(warnings()).toEqual([]);
      });

      it('the order of the components plays no part', async () => {
        for (const schemas of [weight, species]) {
          const { Animal, Pet } = schemas;
          const forward = (await parsed({ Animal, Pet })).models.map(print).sort();
          const backward = (await parsed({ Pet, Animal })).models.map(print).sort();
          expect(backward).toEqual(forward);
          expect(backward.some((line) => line.startsWith('Pet : Animal {'))).toBe(true);
        }
      });

      it('a declaration over a base’s carries no mark: like a field the model adds, it has no inheritedFrom', async () => {
        const spec = await parsed({
          Animal: { type: 'object', properties: { weight: { type: 'number' }, name: { type: 'string' } } },
          Pet: {
            allOf: [R('Animal')],
            properties: { weight: { type: 'integer' }, nickname: { type: 'string' } },
          },
        });
        const pet = modelNamed(spec, 'Pet');
        expect(print(pet)).toBe('Pet : Animal { weight?: integer, nickname?: string, name?: string <- Animal }');
        // `weight` is declared over `Animal`'s, `nickname` is added: the two fields carry the same keys.
        const [over, added] = pet.fields;
        expect(Object.keys(over!).sort()).toEqual(Object.keys(added!).sort());
        expect(over).not.toHaveProperty('inheritedFrom');
        expect(added).not.toHaveProperty('inheritedFrom');
        // The base's `fields` tell them apart, by name.
        expect(declaredOverBase(pet, spec)).toEqual(['weight?: integer over Animal { weight?: number }']);
      });

      it('the base’s fields are complete, so a declaration over what the base inherits in turn is found on the direct base', async () => {
        const spec = await parsed({
          Living: { type: 'object', properties: { born: { type: 'number' } } },
          Animal: { allOf: [R('Living')], properties: { name: { type: 'string' } } },
          Pet: { allOf: [R('Animal')], properties: { born: { type: 'integer' } } },
        });
        expect(spec.models.map(print)).toMatchInlineSnapshot(`
          [
            "Living { born?: number }",
            "Animal : Living { name?: string, born?: number <- Living }",
            "Pet : Animal { born?: integer, name?: string <- Animal }",
          ]
        `);
        expect(declaredOverBase(modelNamed(spec, 'Pet'), spec)).toEqual([
          'born?: integer over Animal { born?: number <- Living }',
        ]);
      });

      it('each base that declares the field carries it: one field over each of two bases, and one over both', async () => {
        const apart = await parsed({
          Animal: { type: 'object', properties: { weight: { type: 'number' } } },
          Owned: { type: 'object', properties: { ownerId: { type: 'string' } } },
          Pet: {
            allOf: [R('Animal'), R('Owned')],
            properties: { weight: { type: 'integer' }, ownerId: pinned('owner_1') },
          },
        });
        expect(print(modelNamed(apart, 'Pet'))).toBe('Pet : Animal & Owned { weight?: integer, ownerId?: "owner_1" }');
        expect(declaredOverBase(modelNamed(apart, 'Pet'), apart)).toEqual([
          'weight?: integer over Animal { weight?: number }',
          'ownerId?: "owner_1" over Owned { ownerId?: string }',
        ]);

        const shared = await parsed({
          Animal: { type: 'object', properties: { tag: { type: 'string' } } },
          Owned: { type: 'object', properties: { tag: { type: 'string' } } },
          Pet: { allOf: [R('Animal'), R('Owned')], properties: { tag: kindEnum } },
        });
        expect(print(modelNamed(shared, 'Pet'))).toBe('Pet : Animal & Owned { tag?: PetTag }');
        expect(declaredOverBase(modelNamed(shared, 'Pet'), shared)).toEqual([
          'tag?: PetTag over Animal { tag?: string }',
          'tag?: PetTag over Owned { tag?: string }',
        ]);
      });

      it('every narrowing a nominal language may type apart keeps the base and is found the same way', async () => {
        const meta = { type: 'object', properties: { a: { type: 'string' } } };
        /** `Pet: { allOf: [{ $ref: Animal }], …own }` over `Animal { value: theirs }`: the model and what the lookup finds. */
        const over = async (theirs: unknown, own: Record<string, unknown>) => {
          const spec = await parsed({
            Animal: { type: 'object', properties: { value: theirs } },
            Pet: { allOf: [R('Animal')], ...own },
          });
          const pet = modelNamed(spec, 'Pet');
          return { pet: print(pet), found: declaredOverBase(pet, spec) };
        };
        const value = (schema: unknown) => ({ properties: { value: schema } });
        expect({
          'integer under number': await over({ type: 'number' }, value({ type: 'integer' })),
          'an enum under its primitive': await over({ type: 'string' }, value(kindEnum)),
          'a pinned value under its primitive': await over({ type: 'string' }, value(pinned('cat'))),
          'an enum under a wider enum, two enums': await over(
            { type: 'string', enum: ['cat', 'dog', 'bird'] },
            value(kindEnum),
          ),
          'an inline model of the same shape, two models': await over(meta, value({ description: 'The pet’s.' })),
          'an inline model with a property more': await over(
            meta,
            value({ type: 'object', properties: { b: { type: 'string' } } }),
          ),
          'one variant of a union': await over(
            { oneOf: [{ type: 'string' }, { type: 'integer' }] },
            value({ type: 'string' }),
          ),
          'a type under an untyped schema': await over({}, value({ type: 'string' })),
          'a map narrowed in its values': await over(
            { type: 'object', additionalProperties: { type: 'string' } },
            value({ type: 'object', additionalProperties: kindEnum }),
          ),
          'required over optional': await over({ type: 'string' }, { required: ['value'] }),
          'non-nullable under nullable': await over(nullable({ type: 'string' }), value({ type: 'string' })),
        }).toMatchInlineSnapshot(`
          {
            "a map narrowed in its values": {
              "found": [
                "value?: { [key]: PetValue } over Animal { value?: { [key]: string } }",
              ],
              "pet": "Pet : Animal { value?: { [key]: PetValue } }",
            },
            "a pinned value under its primitive": {
              "found": [
                "value?: "cat" over Animal { value?: string }",
              ],
              "pet": "Pet : Animal { value?: "cat" }",
            },
            "a type under an untyped schema": {
              "found": [
                "value?: string over Animal { value?: unknown }",
              ],
              "pet": "Pet : Animal { value?: string }",
            },
            "an enum under a wider enum, two enums": {
              "found": [
                "value?: PetValue over Animal { value?: AnimalValue }",
              ],
              "pet": "Pet : Animal { value?: PetValue }",
            },
            "an enum under its primitive": {
              "found": [
                "value?: PetValue over Animal { value?: string }",
              ],
              "pet": "Pet : Animal { value?: PetValue }",
            },
            "an inline model of the same shape, two models": {
              "found": [
                "value?: PetValue over Animal { value?: AnimalValue }",
              ],
              "pet": "Pet : Animal { value?: PetValue }",
            },
            "an inline model with a property more": {
              "found": [
                "value?: PetValue over Animal { value?: AnimalValue }",
              ],
              "pet": "Pet : Animal { value?: PetValue }",
            },
            "integer under number": {
              "found": [
                "value?: integer over Animal { value?: number }",
              ],
              "pet": "Pet : Animal { value?: integer }",
            },
            "non-nullable under nullable": {
              "found": [
                "value?: string over Animal { value?: string | null }",
              ],
              "pet": "Pet : Animal { value?: string }",
            },
            "one variant of a union": {
              "found": [
                "value?: string over Animal { value?: string | integer }",
              ],
              "pet": "Pet : Animal { value?: string }",
            },
            "required over optional": {
              "found": [
                "value: string over Animal { value?: string }",
              ],
              "pet": "Pet : Animal { value: string }",
            },
          }
        `);
      });

      it('a declaration that only documents the base’s field is typed as the base’s, and is found the same way', async () => {
        const spec = await parsed({
          Animal: { type: 'object', properties: { name: { type: 'string' } } },
          Pet: { allOf: [R('Animal')], properties: { name: { description: 'The pet’s name.' } } },
        });
        const pet = modelNamed(spec, 'Pet');
        expect(print(pet)).toBe('Pet : Animal { name?: string }');
        expect(pet.fields[0]).toEqual({
          name: 'name',
          type: { kind: 'primitive', type: 'string' },
          required: false,
          description: 'The pet’s name.',
        });
        expect(declaredOverBase(pet, spec)).toEqual(['name?: string over Animal { name?: string }']);
      });

      it('fields stay complete, so the model can be written without a base it cannot extend', async () => {
        const spec = await parsed({
          Living: { type: 'object', properties: { born: { type: 'number' } } },
          Animal: {
            allOf: [R('Living')],
            properties: { weight: { type: 'number' }, name: { type: 'string' } },
          },
          Pet: { allOf: [R('Animal')], properties: { weight: { type: 'integer' } } },
        });
        const pet = modelNamed(spec, 'Pet');
        expect(print(pet)).toBe('Pet : Animal { weight?: integer, name?: string <- Animal, born?: number <- Animal }');
        // Every field the base ends with is on the model, whether it names the base or is the model's own.
        const names = pet.fields.map((field) => field.name);
        for (const field of modelNamed(spec, 'Animal').fields) expect(names).toContain(field.name);
      });

      it('a model under the base’s carries fields the base’s does not, which typing the member as the base does gives up', async () => {
        const spec = await parsed({
          Animal: { type: 'object', properties: { meta: { type: 'object', properties: { a: { type: 'string' } } } } },
          Pet: {
            allOf: [R('Animal')],
            properties: { meta: { type: 'object', properties: { b: { type: 'string' } } } },
          },
        });
        expect(spec.models.map(print)).toEqual([
          'Animal { meta?: AnimalMeta }',
          'Pet : Animal { meta?: PetMeta }',
          'PetMeta { b?: string, a?: string }',
          'AnimalMeta { a?: string }',
        ]);
        // Two models, neither built on the other: `PetMeta` names no base.
        expect(modelNamed(spec, 'PetMeta').bases).toBeUndefined();
      });
    });
  }
});
