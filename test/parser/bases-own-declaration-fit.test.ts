import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { settleBases } from '../../src/parser/settle-bases.js';
import { markComponentModelRef } from '../../src/parser/schemas.js';
import { collectReferencedNames } from '../../src/engine/generate-files.js';
import { diffSpecs } from '../../src/differ/diff.js';
import type { ApiSpec, Enum, Field, Model, ModelRef, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #681: `settleBases` took any declaration of the model's own as
 * overriding a base's, whatever it declared, so a model that requires,
 * describes or redeclares a property more loosely than a base kept that
 * base, and `interface Pet extends Kinded { tag: string }` over `Kinded {
 * tag?: KindedTag }` does not compile. A base now stays only while the
 * model's own declaration of each field it ends with fits the base's: it
 * admits no value the base's does not.
 */

const R = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string: TypeRef = { kind: 'primitive', type: 'string' };
const model = (name: string): ModelRef => ({ kind: 'model', name });

/** The issue's operation: `GET /pets/{petId}` (`getPet`) returning `Pet`. */
const issuePaths = {
  '/pets/{petId}': {
    get: {
      operationId: 'getPet',
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'OK', content: { 'application/json': { schema: R('Pet') } } } },
    },
  },
};

function documentWith(openapi: string, schemas: Record<string, unknown>) {
  return { openapi, info: { title: 'Repro 681', version: '1.0.0' }, paths: issuePaths, components: { schemas } };
}

const kindEnum = { type: 'string', enum: ['cat', 'dog'] };
/** `tagged.json`'s bases. */
const Tagged = { type: 'object', properties: { tag: { type: 'string' } } };
const Kinded = { type: 'object', properties: { tag: kindEnum, kind: { type: 'string' } } };
const bothBases = [R('Tagged'), R('Kinded')];
/** `widen.json`'s base. */
const Animal = { type: 'object', properties: { name: { type: 'string' }, species: kindEnum } };

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

describe('#681 a base stays only while the model’s own declaration fits its field', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-fit-'));
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
    const nullable = (schema: Record<string, unknown>) =>
      openapi === '3.0.3' ? { ...schema, nullable: true } : { ...schema, type: [schema.type, 'null'] };
    /** One pinned value as the version spells it. */
    const pinned = (value: string | number) =>
      openapi === '3.0.3'
        ? { type: typeof value === 'string' ? 'string' : 'integer', enum: [value] }
        : { const: value };
    const parsed = async (schemas: Record<string, unknown>) => parseJson(documentWith(openapi, schemas));
    const pet = async (schemas: Record<string, unknown>) => print(modelNamed(await parsed(schemas), 'Pet'));

    describe(`on OAS ${openapi}`, () => {
      it('tagged.json: Pet requires tag, so it is on Tagged alone with kind its own', async () => {
        const spec = await parsed({ Tagged, Kinded, Pet: { allOf: bothBases, required: ['tag'] } });
        expect(spec.models.map(print)).toMatchInlineSnapshot(`
          [
            "Tagged { tag?: string }",
            "Kinded { tag?: KindedTag, kind?: string }",
            "Pet : Tagged { tag: string, kind?: string }",
          ]
        `);
        expect(warnings()).toEqual([]);
      });

      it('widen.json: Pet declares species more loosely, so Animal is no base and name is its own', async () => {
        const spec = await parsed({
          Animal,
          Pet: { allOf: [R('Animal')], properties: { species: { type: 'string', description: 'Any species.' } } },
        });
        expect(spec.models.map(print)).toMatchInlineSnapshot(`
          [
            "Animal { name?: string, species?: AnimalSpecies }",
            "Pet { species?: string, name?: string }",
          ]
        `);
        expect(modelNamed(spec, 'Pet').fields).toEqual([
          { name: 'species', type: string, required: false, description: 'Any species.' },
          { name: 'name', type: string, required: false },
        ]);
        expect(warnings()).toEqual([]);
      });

      it('tagged.json without required, with a description on tag, or with required in a third member, is on Tagged alone', async () => {
        // Without `required: [tag]`, `tag` is `Tagged`'s as written.
        expect(await pet({ Tagged, Kinded, Pet: { allOf: bothBases } })).toBe(
          'Pet : Tagged { tag?: string <- Tagged, kind?: string }',
        );
        // A `description` in `Pet`'s own `properties`, alone or beside a type.
        for (const tag of [{ description: 'The tag.' }, { type: 'string', description: 'The tag.' }]) {
          const spec = await parsed({ Tagged, Kinded, Pet: { allOf: bothBases, properties: { tag } } });
          expect(print(modelNamed(spec, 'Pet'))).toBe('Pet : Tagged { tag?: string, kind?: string }');
          expect(modelNamed(spec, 'Pet').fields[0]).toMatchObject({ description: 'The tag.' });
        }
        // `required: [tag]` in a third member.
        expect(await pet({ Tagged, Kinded, Pet: { allOf: [...bothBases, { required: ['tag'] }] } })).toBe(
          'Pet : Tagged { tag: string, kind?: string }',
        );
      });

      it('a nullable declaration over a required, non-nullable field drops the base', async () => {
        const spec = await parsed({
          Animal: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
          Pet: { allOf: [R('Animal')], properties: { name: nullable({ type: 'string' }) } },
        });
        expect(spec.models.map(print)).toEqual(['Animal { name: string }', 'Pet { name: string | null }']);
      });

      it('the members the other way round type tag as the enum, which fits both bases', async () => {
        // `Kinded`'s declaration is the first typing one, so `Pet.tag` is the
        // enum: with `required`, the model's own, a subset of `Kinded`'s
        // values and of `Tagged`'s strings — `interface Pet extends Kinded,
        // Tagged { tag: PetTag }` compiles.
        const reversed = [R('Kinded'), R('Tagged')];
        expect(await pet({ Tagged, Kinded, Pet: { allOf: reversed, required: ['tag'] } })).toBe(
          'Pet : Kinded & Tagged { tag: PetTag, kind?: string <- Kinded }',
        );
        // Without it `tag` is `Kinded`'s as written, which `Tagged` declares
        // differently: `interface Pet extends Kinded, Tagged {}` does not
        // compile, so `Tagged` is no base (#591).
        expect(await pet({ Tagged, Kinded, Pet: { allOf: reversed } })).toBe(
          'Pet : Kinded { tag?: PetTag <- Kinded, kind?: string <- Kinded }',
        );
      });

      it('the order of the components plays no part', async () => {
        const Pet = { allOf: bothBases, required: ['tag'] };
        const orders: Array<Record<string, unknown>> = [
          { Tagged, Kinded, Pet },
          { Kinded, Tagged, Pet },
          { Pet, Tagged, Kinded },
          { Pet, Kinded, Tagged },
          { Tagged, Pet, Kinded },
          { Kinded, Pet, Tagged },
        ];
        for (const schemas of orders) {
          expect(await pet(schemas), Object.keys(schemas).join()).toBe('Pet : Tagged { tag: string, kind?: string }');
        }
      });

      /**
       * `Pet: { allOf: [{ $ref: Animal }], properties: { value: own } }` over
       * `Animal { value: theirs, other }`: whether `Animal` stays, read from
       * `bases` and from `other`'s `inheritedFrom` alike.
       */
      const over = async (
        theirs: unknown,
        own: unknown,
        extra: { components?: Record<string, unknown>; required?: string[]; baseRequired?: string[] } = {},
      ) => {
        const spec = await parsed({
          ...extra.components,
          Animal: {
            type: 'object',
            ...(extra.baseRequired ? { required: extra.baseRequired } : {}),
            properties: { value: theirs, other: { type: 'string' } },
          },
          Pet: {
            allOf: [R('Animal')],
            ...(extra.required ? { required: extra.required } : {}),
            properties: { value: own },
          },
        });
        const built = modelNamed(spec, 'Pet');
        const other = built.fields.find((f) => f.name === 'other') as Field;
        const value = built.fields.find((f) => f.name === 'value') as Field;
        // A declaration the merge sets aside leaves the field the base's.
        if (value.inheritedFrom) return 'inherited';
        expect(refName(other.inheritedFrom), 'other follows the base').toBe(built.bases ? 'Animal' : undefined);
        return built.bases ? 'kept' : 'dropped';
      };
      type Case = [label: string, theirs: unknown, own: unknown, extra?: Parameters<typeof over>[2]];
      /** Every case's outcome by its label, to compare a whole matrix at once. */
      const outcomes = async (cases: Case[]) => {
        const results: Record<string, string> = {};
        for (const [label, theirs, own, extra] of cases) results[label] = await over(theirs, own, extra);
        return results;
      };
      const all = (cases: Case[], outcome: string) => Object.fromEntries(cases.map(([label]) => [label, outcome]));

      it('a declaration that admits no more than the base’s keeps the base', async () => {
        const wide = { type: 'string', enum: ['cat', 'dog', 'bird'] };
        const owner = { type: 'object', properties: { id: { type: 'string' } } };
        const keeper = { type: 'object', properties: { badge: { type: 'integer' } } };
        const cases: Case[] = [
          ['the same declaration', { type: 'string' }, { type: 'string' }],
          ['an enum under its primitive', { type: 'string' }, kindEnum],
          ['an enum under a wider enum', wide, kindEnum],
          ['a pinned value under an enum that lists it', kindEnum, pinned('cat')],
          ['a pinned value under its primitive', { type: 'string' }, pinned('cat')],
          ['a pinned integer under integer', { type: 'integer' }, pinned(3)],
          ['a pinned integer under number', { type: 'number' }, pinned(3)],
          ['an integer enum under integer', { type: 'integer' }, { type: 'integer', enum: [1, 2] }],
          ['integer under number', { type: 'number' }, { type: 'integer' }],
          ['the same format', { type: 'string', format: 'uuid' }, { type: 'string', format: 'uuid', maxLength: 36 }],
          ...(openapi === '3.1.0'
            ? ([['one type of a type list', { type: ['string', 'integer'] }, { type: 'string' }]] satisfies Case[])
            : []),
          ['non-nullable under nullable', nullable({ type: 'string' }), { type: 'string' }],
          ['nullable under nullable', nullable({ type: 'string' }), nullable(kindEnum)],
          ['required over optional', { type: 'string' }, { type: 'string' }, { required: ['value'] }],
          ['required where the base requires', { type: 'string' }, kindEnum, { baseRequired: ['value'] }],
          ['anything under an untyped schema', {}, { type: 'array', items: { type: 'string' } }],
          ['a nullable type under an untyped schema', {}, nullable({ type: 'string' })],
          [
            'map values that fit',
            { type: 'object', additionalProperties: { type: 'string' } },
            { type: 'object', additionalProperties: kindEnum },
          ],
          ['one variant of a union', { oneOf: [{ type: 'string' }, { type: 'integer' }] }, { type: 'string' }],
          ['a value of one variant', { oneOf: [{ type: 'string' }, { type: 'integer' }] }, kindEnum],
          [
            'a union whose every variant fits',
            { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }] },
            { oneOf: [{ type: 'integer' }, kindEnum] },
          ],
          ['a component enum under itself', R('Kind'), R('Kind'), { components: { Kind: kindEnum } }],
          [
            'a component enum under a wider one',
            R('Kind'),
            R('SmallKind'),
            { components: { Kind: wide, SmallKind: kindEnum } },
          ],
          ['a component under itself', R('Owner'), R('Owner'), { components: { Owner: owner } }],
          ['an inline object of the same shape', owner, owner],
          [
            // Two object declarations are conjoined, so the model's has the base's properties too.
            'an inline object with a property more',
            owner,
            { type: 'object', properties: { name: { type: 'string' } } },
          ],
          [
            'an inline object that narrows a property',
            { type: 'object', properties: { kind: { type: 'string' } } },
            { type: 'object', required: ['kind'], properties: { kind: kindEnum } },
          ],
          ['a component over an inline object of its shape', owner, R('Owner'), { components: { Owner: owner } }],
          [
            'a component built on the base’s',
            R('Owner'),
            R('Keeper'),
            {
              components: { Owner: owner, Keeper: { allOf: [R('Owner')], properties: { badge: { type: 'integer' } } } },
            },
          ],
          [
            'a component built on the base’s, under a nullable reference',
            openapi === '3.0.3' ? { allOf: [R('Owner')], nullable: true } : { oneOf: [R('Owner'), { type: 'null' }] },
            R('Keeper'),
            {
              components: { Owner: owner, Keeper: { allOf: [R('Owner')], properties: { badge: { type: 'integer' } } } },
            },
          ],
          [
            // Read both ways an emitter writes a named union: as its variants, and as the merge `fields` carry.
            'one variant under a named union',
            R('Either'),
            R('Owner'),
            { components: { Owner: owner, Keeper: keeper, Either: { oneOf: [R('Owner'), R('Keeper')] } } },
          ],
          [
            'a named union under a wider one',
            R('Any'),
            R('Either'),
            {
              components: {
                Owner: owner,
                Keeper: keeper,
                Either: { oneOf: [R('Owner'), R('Keeper')] },
                Any: { oneOf: [R('Owner'), R('Keeper'), { type: 'string' }] },
              },
            },
          ],
          [
            'a named union under itself',
            R('Either'),
            R('Either'),
            { components: { Owner: owner, Keeper: keeper, Either: { oneOf: [R('Owner'), R('Keeper')] } } },
          ],
          [
            'a named union under an inline union that lists it',
            { oneOf: [R('Either'), { type: 'string' }] },
            R('Either'),
            { components: { Owner: owner, Keeper: keeper, Either: { oneOf: [R('Owner'), R('Keeper')] } } },
          ],
          ['a tighter upper limit', { type: 'string', maxLength: 5 }, { type: 'string', maxLength: 3 }],
          ['a tighter lower limit', { type: 'integer', minimum: 1 }, { type: 'integer', minimum: 2, maximum: 9 }],
          ['a limit the base has none of', { type: 'string' }, { type: 'string', pattern: '^pet_' }],
          [
            'the same pattern beside a tighter length',
            { type: 'string', pattern: '^pet_', maxLength: 9 },
            { type: 'string', pattern: '^pet_', maxLength: 8 },
          ],
          ['enum values within the limits', { type: 'string', minLength: 2, maxLength: 5 }, kindEnum],
          [
            'array limits that tighten',
            { type: 'array', items: { type: 'string' }, maxItems: 5 },
            { type: 'array', items: { type: 'string' }, maxItems: 4, minItems: 1, uniqueItems: true },
          ],
          [
            // Two array declarations are conjoined, the stricter bound kept, so the model's is no looser.
            'array limits the base’s tighten',
            { type: 'array', items: { type: 'string' }, maxItems: 5, uniqueItems: true },
            { type: 'array', items: { type: 'string' }, maxItems: 9 },
          ],
        ];
        expect(await outcomes(cases)).toEqual(all(cases, 'kept'));
      });

      it('what a declaration says beside its type is its own and no part of the fit', async () => {
        const annotations: Array<[string, Record<string, unknown>]> = [
          ['description', { description: 'The value.' }],
          ['deprecated', { deprecated: true }],
          ['readOnly', { readOnly: true }],
          ['writeOnly', { writeOnly: true }],
          ['default', { default: 'cat' }],
          ['example', { example: 'cat' }],
          ['extensions', { 'x-internal': true }],
        ];
        for (const [label, annotation] of annotations) {
          // Typeless, annotating the base's declaration, and beside a type of its own.
          expect(await over({ type: 'string' }, annotation), label).toBe('kept');
          expect(await over({ type: 'string' }, { type: 'string', ...annotation }), label).toBe('kept');
          // The base's annotation, which the model's declaration lacks.
          expect(await over({ type: 'string', ...annotation }, { type: 'string' }), label).toBe('kept');
        }
      });

      it('a declaration that admits a value the base’s does not drops the base', async () => {
        const wide = { type: 'string', enum: ['cat', 'dog', 'bird'] };
        const owner = { type: 'object', properties: { id: { type: 'string' } } };
        const keeper = { type: 'object', properties: { badge: { type: 'integer' } } };
        const cases: Case[] = [
          ['a primitive over an enum', kindEnum, { type: 'string' }],
          ['a wider enum', kindEnum, wide],
          ['an enum with one value more', kindEnum, { type: 'string', enum: ['cat', 'bird'] }],
          ['a pinned value the enum lacks', kindEnum, pinned('bird')],
          ['another pinned value', pinned('cat'), pinned('dog')],
          ['an enum over a pinned value', pinned('cat'), kindEnum],
          ['a string enum under integer', { type: 'integer' }, kindEnum],
          ['a pinned integer under string', { type: 'string' }, pinned(3)],
          ['nullable over non-nullable', { type: 'string' }, nullable({ type: 'string' })],
          ['a nullable enum over a non-nullable string', { type: 'string' }, nullable(kindEnum)],
          ['number over integer', { type: 'integer' }, { type: 'number' }],
          ['an integer format under number', { type: 'number' }, { type: 'integer', format: 'int32' }],
          ['a string over a boolean', { type: 'boolean' }, { type: 'string' }],
          ['a format over none', { type: 'string' }, { type: 'string', format: 'date-time' }],
          ['none over a format', { type: 'string', format: 'uuid' }, { type: 'string' }],
          ['another format', { type: 'string', format: 'uuid' }, { type: 'string', format: 'date' }],
          ['an enum under a formatted string', { type: 'string', format: 'uuid' }, kindEnum],
          [
            'array items that do not fit',
            { type: 'array', items: kindEnum },
            { type: 'array', items: { type: 'string' } },
          ],
          [
            // `Animal & { value?: 'cat'[] }` types `value` as `string[] & 'cat'[]`, whose `map` reads a string.
            'array items narrowed, which an intersection does not type as the model’s',
            { type: 'array', items: { type: 'string' } },
            { type: 'array', items: kindEnum },
          ],
          ['an array over its item', { type: 'string' }, { type: 'array', items: { type: 'string' } }],
          [
            'map values that do not fit',
            { type: 'object', additionalProperties: kindEnum },
            { type: 'object', additionalProperties: { type: 'string' } },
          ],
          [
            'a union over one of its variants',
            { type: 'string' },
            { oneOf: [{ type: 'string' }, { type: 'integer' }] },
          ],
          [
            'a union with one variant more',
            { oneOf: [{ type: 'string' }, { type: 'integer' }] },
            { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }] },
          ],
          ['a wider component enum', R('SmallKind'), R('Kind'), { components: { Kind: wide, SmallKind: kindEnum } }],
          [
            'an inline object that types a property more loosely',
            { type: 'object', properties: { kind: kindEnum } },
            { type: 'object', properties: { kind: { type: 'string' } } },
          ],
          [
            'an inline object that no longer requires a property',
            { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
            { type: 'object', properties: { id: nullable({ type: 'string' }) } },
          ],
          [
            'a component that types a property more loosely',
            R('Owner'),
            R('Keeper'),
            {
              components: {
                Owner: { type: 'object', properties: { kind: kindEnum } },
                Keeper: { type: 'object', properties: { kind: { type: 'string' } } },
              },
            },
          ],
          [
            'a named union over one of its variants',
            R('Owner'),
            R('Either'),
            { components: { Owner: owner, Keeper: keeper, Either: { oneOf: [R('Owner'), R('Keeper')] } } },
          ],
          [
            'a named union with one variant more',
            R('Either'),
            R('Any'),
            {
              components: {
                Owner: owner,
                Keeper: keeper,
                Either: { oneOf: [R('Owner'), R('Keeper')] },
                Any: { oneOf: [R('Owner'), R('Keeper'), { type: 'string' }] },
              },
            },
          ],
          [
            // It fits the variant `{ id }`, and not the merge of the variants a reader of `fields` writes.
            'a component that fits one variant of a named union and not the merge of them',
            { $ref: '#/components/schemas/Merged' },
            R('Keeper'),
            {
              components: {
                Keeper: { type: 'object', properties: { id: { type: 'string' }, badge: { type: 'string' } } },
                Merged: { oneOf: [owner, keeper] },
              },
            },
          ],
          [
            // A model is not read as a map: an interface is not assignable to an index signature.
            'a component over a free-form object',
            { type: 'object' },
            R('Owner'),
            { components: { Owner: owner } },
          ],
          ...(openapi === '3.1.0'
            ? ([
                [
                  'a type under a type list with limits of its own',
                  { type: ['string', 'integer'], maxLength: 5 },
                  { type: 'string', maxLength: 3 },
                ],
              ] satisfies Case[])
            : []),
          ['a looser upper limit', { type: 'string', maxLength: 5 }, { type: 'string', maxLength: 10 }],
          ['no limit over one', { type: 'string', maxLength: 5 }, { type: 'string' }],
          ['a looser lower limit', { type: 'integer', minimum: 2 }, { type: 'integer', minimum: 1 }],
          ['another pattern', { type: 'string', pattern: '^pet_' }, { type: 'string', pattern: '^p' }],
          [
            'an enum value beyond the limit',
            { type: 'string', maxLength: 5 },
            { type: 'string', enum: ['rex', 'maximus'] },
          ],
          ['an enum under a pattern, which is not evaluated', { type: 'string', pattern: '^c' }, kindEnum],
        ];
        expect(await outcomes(cases)).toEqual(all(cases, 'dropped'));
      });

      it('a model fits one it carries every field of: a component built on the base’s, and the conjunction of two object declarations', async () => {
        const Named = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
        const Dog = { allOf: [R('Named')], properties: { breed: { type: 'string' } } };
        // `friend: { $ref: Dog }` over `Holder.friend: { $ref: Named }`: every
        // `Dog` is a `Named`, so the field is `Dog` (#733; it was `PetFriend`,
        // a copy of `Dog`), which fits `Named`.
        const narrowed = await parsed({
          Named,
          Dog,
          Holder: { type: 'object', properties: { friend: R('Named') } },
          Pet: { allOf: [R('Holder')], required: ['friend'], properties: { friend: R('Dog') } },
        });
        expect(narrowed.models.map(print)).toEqual([
          'Named { name: string }',
          'Dog : Named { breed?: string, name: string <- Named }',
          'Holder { friend?: Named }',
          'Pet : Holder { friend: Dog }',
        ]);
        // Under a union the reference stays as written, and `Dog` fits `Named`.
        const variant = await parsed({
          Named,
          Dog,
          Holder: { type: 'object', properties: { friend: { oneOf: [R('Named'), { type: 'string' }] } } },
          Pet: { allOf: [R('Holder')], properties: { friend: R('Dog') } },
        });
        expect(print(modelNamed(variant, 'Pet'))).toBe('Pet : Holder { friend?: Dog }');
        // `LooseDog` redeclares `name` as nullable, so `Named` is no base of
        // it, and neither a `Pet` whose `friend` is a `LooseDog` — the
        // component itself, which composes `Named` (#733; it was `PetFriend`,
        // a copy of it) — nor one whose `friend` may be one is on `Holder`,
        // whichever component the document declares first.
        const LooseDog = { allOf: [R('Named')], properties: { name: nullable({ type: 'string' }) } };
        const Holder = { type: 'object', properties: { friend: R('Named') } };
        const Pet = { allOf: [R('Holder')], properties: { friend: R('LooseDog') } };
        const Pack = { allOf: [R('Holder')], properties: { friend: { oneOf: [R('Dog'), R('LooseDog')] } } };
        const Kennel = { allOf: [R('Holder')], properties: { friend: { oneOf: [R('Dog'), R('Named')] } } };
        for (const schemas of [
          { Named, Dog, LooseDog, Holder, Pet, Pack, Kennel },
          { Kennel, Pack, Pet, Holder, LooseDog, Dog, Named },
        ]) {
          const spec = await parsed(schemas);
          const printed = Object.fromEntries(spec.models.map((m) => [m.name, print(m)]));
          expect(printed).toMatchObject({
            LooseDog: 'LooseDog { name: string | null }',
            Pet: 'Pet { friend?: LooseDog }',
            Pack: 'Pack { friend?: Dog | LooseDog }',
            Kennel: 'Kennel : Holder { friend?: Dog | Named }',
          });
        }
      });

      it('reads the declaration the merge settles on, wherever the model writes it', async () => {
        const loose = { type: 'string', description: 'Any species.' };
        // Beside the `allOf` (`widen.json`) and in an inline member before
        // the `$ref`, the model's declaration types `species`.
        for (const Pet of [
          { allOf: [R('Animal')], properties: { species: loose } },
          { allOf: [{ type: 'object', properties: { species: loose } }, R('Animal')] },
        ]) {
          expect(await pet({ Animal, Pet })).toBe('Pet { species?: string, name?: string }');
        }
        // In a member after it, `Animal`'s typing declaration outranks the
        // model's, which the merge sets aside: `species` stays `Animal`'s.
        expect(
          await pet({ Animal, Pet: { allOf: [R('Animal'), { type: 'object', properties: { species: loose } }] } }),
        ).toBe('Pet : Animal { name?: string <- Animal, species?: PetSpecies <- Animal }');
      });

      it('reads a field a base inherits in turn as that base’s, and each direct base on its own', async () => {
        const Living = { type: 'object', properties: { born: { type: 'string' } } };
        const Creature = { allOf: [R('Living')], properties: { name: { type: 'string' } } };
        // `born` is `Living`'s, on `Creature` through its base: a nullable
        // `born` fits neither, and `Pet` names `Creature` alone.
        expect(
          await pet({
            Living,
            Creature,
            Pet: { allOf: [R('Creature')], properties: { born: nullable({ type: 'string' }) } },
          }),
        ).toBe('Pet { born?: string | null, name?: string }');
        // Naming both, a nullable `name` fits `Living`, which declares none,
        // and not `Creature`: `born`, which `Creature` lent, is `Pet`'s own.
        expect(
          await pet({
            Living,
            Creature,
            Pet: { allOf: [R('Creature'), R('Living')], properties: { name: nullable({ type: 'string' }) } },
          }),
        ).toBe('Pet : Living { name?: string | null, born?: string }');
        // A narrower `born` fits both.
        expect(
          await pet({
            Living,
            Creature,
            Pet: { allOf: [R('Creature'), R('Living')], required: ['born'], properties: { born: pinned('2020') } },
          }),
        ).toBe('Pet : Creature & Living { born: "2020", name?: string <- Creature }');
      });

      it('settles a dispatcher’s base and a model that reaches itself by the same rule', async () => {
        const Base = { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' } } };
        const variants = {
          oneOf: [
            { type: 'object', properties: { kind: pinned('cat'), meow: { type: 'string' } } },
            { type: 'object', properties: { kind: pinned('dog'), bark: { type: 'string' } } },
          ],
        };
        const dispatcher = async (id: unknown) => {
          const spec = await parsed({ Base, Pet: { allOf: [R('Base'), variants], properties: { id } } });
          const built = modelNamed(spec, 'Pet');
          expect(built.discriminator).toEqual({ property: 'kind', mapping: { cat: 'PetCat', dog: 'PetDog' } });
          return print(built);
        };
        expect(await dispatcher({ type: 'string', description: 'The id.' })).toBe(
          'Pet : Base { id?: string, kind?: string <- Base }',
        );
        expect(await dispatcher(nullable({ type: 'string' }))).toBe('Pet { id?: string | null, kind?: string }');
        // `next: { $ref: Pet }` over `Node.next: { $ref: Node }` is `Pet`,
        // which composes `Node` (#733; it was `PetNext`, a copy of `Pet`),
        // reaches itself and fits `Node`.
        const Node = { type: 'object', properties: { next: R('Node'), id: { type: 'string' } } };
        const chained = await parsed({ Node, Pet: { allOf: [R('Node')], properties: { next: R('Pet') } } });
        expect(chained.models.map(print)).toEqual([
          'Node { next?: Node, id?: string }',
          'Pet : Node { next?: Pet, id?: string <- Node }',
        ]);
      });

      it('a declaration that only requires or documents a field with limits that cannot be evaluated keeps the base', async () => {
        // The base's enum, pinned value or enum reference beside a
        // `pattern` or a `multipleOf`: the model's declaration is the
        // base's, so it fits whatever the limits say.
        const pattern = '^[a-z]+$';
        const fields: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
          ['an enum beside a pattern', { ...kindEnum, pattern }],
          ['a pinned value beside a pattern', { ...pinned('cat'), pattern }],
          ['an enum beside multipleOf', { type: 'integer', enum: [2, 4], multipleOf: 2 }],
          ['a reference to an enum beside a pattern', { allOf: [R('Species')], pattern }, { Species: kindEnum }],
        ];
        for (const [label, value, components] of fields) {
          const base = { type: 'object', properties: { value, name: { type: 'string' } } };
          for (const own of [{ required: ['value'] }, { properties: { value: { description: 'Its own.' } } }]) {
            const spec = await parsed({ ...components, Animal: base, Pet: { allOf: [R('Animal')], ...own } });
            const built = modelNamed(spec, 'Pet');
            expect(built.bases?.map(refName), label).toEqual(['Animal']);
            expect(
              built.fields.map((f) => [f.name, refName(f.inheritedFrom)]),
              label,
            ).toEqual([
              ['value', undefined],
              ['name', 'Animal'],
            ]);
          }
        }
      });

      it('settles two deep trees and two meshes of components that type one field, once per pair', async () => {
        // `Own<i> { l: Own<i+1>, r: Own<i+1> }` over `Base<i>` the same,
        // twenty levels down: read path by path that is a million walks.
        const depth = 20;
        const tree: Record<string, unknown> = {};
        for (let level = 0; level < depth; level++) {
          for (const family of ['Own', 'Base']) {
            const next = R(`${family}${level + 1}`);
            tree[`${family}${level}`] = { type: 'object', properties: { l: next, r: next } };
          }
        }
        tree[`Own${depth}`] = {
          type: 'object',
          required: ['x'],
          properties: { x: { type: 'string' }, y: { type: 'string' } },
        };
        tree[`Base${depth}`] = { type: 'object', properties: { x: { type: 'string' } } };
        const typing = (base: string, own: string) => ({
          Holder: { type: 'object', properties: { data: { oneOf: [R(base), { type: 'integer' }] } } },
          Pet: { allOf: [R('Holder')], properties: { data: R(own) } },
        });
        expect(await pet({ ...tree, ...typing('Base0', 'Own0') })).toBe('Pet : Holder { data?: Own0 }');
        expect(await pet({ ...tree, ...typing('Own0', 'Base0') })).toBe('Pet { data?: Base0 }');
        // Two families of ten, each model naming every other of its family.
        const size = 10;
        const mesh = (last: unknown): Record<string, unknown> => {
          const schemas: Record<string, unknown> = {};
          for (const family of ['Own', 'Base']) {
            for (let index = 0; index < size; index++) {
              const properties: Record<string, unknown> = {
                x: family === 'Own' && index === size - 1 ? last : { type: 'string' },
              };
              for (let other = 0; other < size; other++) {
                if (other !== index) properties[`f${other}`] = R(`${family}${other}`);
              }
              schemas[`${family}${index}`] = { type: 'object', properties };
            }
          }
          return schemas;
        };
        expect(await pet({ ...mesh(kindEnum), ...typing('Base0', 'Own0') })).toBe('Pet : Holder { data?: Own0 }');
        expect(await pet({ ...mesh({ type: 'integer' }), ...typing('Base0', 'Own0') })).toBe('Pet { data?: Own0 }');
      });

      it('reads a base that is a union through its variants too', async () => {
        const text = { type: 'string' };
        const Cat = { type: 'object', required: ['kind'], properties: { kind: pinned('cat'), meow: text } };
        const Dog = { type: 'object', required: ['kind'], properties: { kind: pinned('dog'), bark: text } };
        const Shape = { oneOf: [R('Cat'), R('Dog')] };
        const on = async (properties: Record<string, unknown>, shape: unknown = Shape) =>
          pet({ Cat, Dog, Shape: shape, Pet: { allOf: [R('Shape')], properties } });
        // `Shape`'s variants are `$ref`s, so it has no fields of its own:
        // the variants' are read. Nothing of `Pet`'s is one of theirs.
        expect(await on({ extra: text })).toBe('Pet : Shape { extra?: string }');
        // `kind: string` over the variants' pinned, required `kind`:
        // `Shape & { kind?: string }` types `kind` as `'cat' | 'dog'`.
        expect(await on({ kind: text })).toBe('Pet { kind?: string }');
        // A field typed otherwise than the one variant that declares it.
        expect(await on({ meow: { type: 'integer' } })).toBe('Pet { meow?: integer }');
        // Restating one variant's pinned `kind`, and requiring it as that
        // variant does: `Pet` is the `Cat` of `Shape`, and `Shape & { kind:
        // 'cat' }` types `kind` as `fields` does — whichever way round the
        // variants are written, under the `discriminator` keyword or not,
        // and through a nullable union.
        const restated = { allOf: [R('Shape')], required: ['kind'], properties: { kind: pinned('cat') } };
        const maybe =
          openapi === '3.0.3' ? { ...Shape, nullable: true } : { oneOf: [R('Cat'), R('Dog'), { type: 'null' }] };
        for (const shape of [
          Shape,
          { oneOf: [R('Dog'), R('Cat')] },
          { ...Shape, discriminator: { propertyName: 'kind' } },
          maybe,
        ]) {
          expect(await pet({ Cat, Dog, Shape: shape, Pet: restated }), JSON.stringify(shape)).toBe(
            'Pet : Shape { kind: "cat" }',
          );
        }
        expect(await pet({ Cat, Dog, Shape: maybe, Pet: { allOf: [R('Shape')], properties: { kind: text } } })).toBe(
          'Pet { kind?: string }',
        );
        // Not requiring it, where `Cat` does, or pinning a value no variant
        // pins, fits no variant.
        expect(await on({ kind: pinned('cat') })).toBe('Pet { kind?: "cat" }');
        expect(await pet({ Cat, Dog, Shape, Pet: { ...restated, properties: { kind: pinned('bird') } } })).toBe(
          'Pet { kind: "bird" }',
        );
        // One variant has to agree on every field it shares with the
        // model. `kind: 'cat'` fits `Tabby` alone and `name: string` fits
        // `Hound` alone: `(Tabby | Hound) & { kind: 'cat'; name: string }`
        // is `Tabby`'s branch alone, which types `name` as `'tom'`.
        const Tabby = {
          type: 'object',
          required: ['kind', 'name'],
          properties: { kind: pinned('cat'), name: pinned('tom') },
        };
        const Hound = { type: 'object', required: ['kind', 'name'], properties: { kind: pinned('dog'), name: text } };
        const named = async (name: unknown) =>
          pet({
            Tabby,
            Hound,
            Shape: { oneOf: [R('Tabby'), R('Hound')] },
            Pet: { allOf: [R('Shape')], required: ['kind', 'name'], properties: { kind: pinned('cat'), name } },
          });
        expect(await named(text)).toBe('Pet { kind: "cat", name: string }');
        expect(await named(pinned('tom'))).toBe('Pet : Shape { kind: "cat", name: "tom" }');
        // Beside a model base: a field `Pet` takes from `Animal` has to be
        // the field of a variant that declares it.
        const beside = async (meow: unknown) =>
          pet({
            Cat,
            Dog,
            Shape,
            Animal: { type: 'object', properties: { name: text, meow } },
            Pet: { allOf: [R('Animal'), R('Shape')], properties: { extra: text } },
          });
        expect(await beside(text)).toBe(
          'Pet : Animal & Shape { extra?: string, name?: string <- Animal, meow?: string <- Animal }',
        );
        expect(await beside({ type: 'integer' })).toBe(
          'Pet : Animal { extra?: string, name?: string <- Animal, meow?: integer <- Animal }',
        );
        // `r: integer` over variants that declare `r` as an enum and as a
        // pinned value fits neither.
        expect(
          await pet({
            Cat: { type: 'object', properties: { r: { type: 'string', enum: ['a', 'b'] } } },
            Dog: { type: 'object', properties: { r: pinned('c') } },
            Shape: { anyOf: [R('Cat'), R('Dog')] },
            Pet: { allOf: [R('Shape')], properties: { r: { type: 'integer' } } },
          }),
        ).toBe('Pet { r?: integer }');
        // The same under the `discriminator` keyword.
        const keyed = { ...Shape, discriminator: { propertyName: 'kind' } };
        expect(await on({ extra: text }, keyed)).toBe('Pet : Shape { extra?: string }');
        expect(await on({ meow: { type: 'integer' } }, keyed)).toBe('Pet { meow?: integer }');
        // Variants that pin nothing are flattened into `Pet` as optional
        // fields: the same fields while the variants leave them optional,
        // and a narrower declaration of the model's own fits.
        const A = { type: 'object', properties: { r: kindEnum } };
        const B = { type: 'object', properties: { w: { type: 'integer' } } };
        const flat = async (own: Record<string, unknown>, a: unknown = A) =>
          pet({ A: a, B, Shape: { oneOf: [R('A'), R('B')] }, Pet: { allOf: [R('Shape')], ...own } });
        expect(await flat({ properties: { extra: text } })).toBe(
          'Pet : Shape { extra?: string, r?: PetR, w?: integer }',
        );
        expect(await flat({ required: ['r'], properties: { r: pinned('cat') } })).toBe(
          'Pet : Shape { r: "cat", w?: integer }',
        );
        expect(await flat({ properties: { r: text } })).toBe('Pet { r?: string, w?: integer }');
        expect(await flat({ properties: { w: text } })).toBe('Pet { w?: string, r?: PetR }');
        // A variant that requires its field is not what the optional copy
        // on `Pet` fits.
        const requiring = { type: 'object', required: ['r'], properties: { r: kindEnum } };
        expect(await flat({ properties: { extra: text } }, requiring)).toBe(
          'Pet { extra?: string, r?: PetR, w?: integer }',
        );
        // The variants written inline read as the same variants behind
        // `$ref`s do, case by case.
        const inline = async (own: Record<string, unknown>, a: unknown = A) =>
          pet({ Shape: { oneOf: [a, B] }, Pet: { allOf: [R('Shape')], ...own } });
        const spellings: Array<[Record<string, unknown>, unknown, string]> = [
          [{ properties: { extra: text } }, A, 'Pet : Shape { extra?: string, r?: PetR, w?: integer }'],
          [{ required: ['r'], properties: { r: pinned('cat') } }, A, 'Pet : Shape { r: "cat", w?: integer }'],
          [{ properties: { r: text } }, A, 'Pet { r?: string, w?: integer }'],
          [{ properties: { extra: text } }, requiring, 'Pet { extra?: string, r?: PetR, w?: integer }'],
        ];
        for (const [own, a, expected] of spellings) {
          expect(await flat(own, a), expected).toBe(expected);
          expect(await inline(own, a), expected).toBe(expected);
        }
        // A union of unions is read to its models; a variant that is no
        // model declares nothing; a union of nothing is no base.
        const nested = {
          Cat,
          Dog,
          Inner: Shape,
          Shape: { oneOf: [R('Inner'), { type: 'object', properties: { other: text } }] },
        };
        expect(await pet({ ...nested, Pet: { allOf: [R('Shape')], properties: { kind: { type: 'integer' } } } })).toBe(
          'Pet { kind?: integer, meow?: string, bark?: string, other?: string }',
        );
        expect(
          await pet({ A, Shape: { oneOf: [R('A'), text] }, Pet: { allOf: [R('Shape')], properties: { extra: text } } }),
        ).toBe('Pet : Shape { extra?: string, r?: PetR }');
        expect(await pet({ Empty: { oneOf: [] }, Pet: { allOf: [R('Empty')], properties: { extra: text } } })).toBe(
          'Pet { extra?: string }',
        );
        // A dispatcher under a model: its variant models carry its fields.
        const Base = { type: 'object', required: ['id'], properties: { id: text } };
        const Disp = { allOf: [R('Base'), { oneOf: [Cat, Dog] }] };
        expect(await pet({ Base, Disp, Pet: { allOf: [R('Disp')], properties: { extra: text } } })).toBe(
          'Pet : Disp { extra?: string, id: string <- Disp }',
        );
        expect(await pet({ Base, Disp, Pet: { allOf: [R('Disp')], properties: { kind: { type: 'integer' } } } })).toBe(
          'Pet { kind?: integer, id: string }',
        );
      });

      it('reads a named union that types a field each way an emitter writes one, and an empty one as fitting nothing', async () => {
        // `Other` fits the variant `ShapeWithR`, and not the merge of the
        // variants an emitter reading `fields` writes (`w?: number`).
        const Shape = {
          oneOf: [
            { type: 'object', properties: { r: { type: 'string' } } },
            { type: 'object', properties: { w: { type: 'integer' } } },
          ],
        };
        const Other = { type: 'object', properties: { r: { type: 'string' }, w: { type: 'string' } } };
        const maybe = (name: string) =>
          openapi === '3.0.3' ? { allOf: [R(name)], nullable: true } : { anyOf: [R(name), { type: 'null' }] };
        const fits = await parsed({
          Shape,
          Other,
          Holder: { type: 'object', properties: { shape: maybe('Shape') } },
          Pet: { allOf: [R('Holder')], properties: { shape: maybe('Other') } },
        });
        // (OAS 3.0 reads the nullable `allOf` of a reference as the reference.)
        expect(print(modelNamed(fits, 'Pet'))).toBe(
          openapi === '3.0.3' ? 'Pet { shape?: Other }' : 'Pet { shape?: Other | null }',
        );
        // The other way round: a union whose every variant requires `id`,
        // under a model that requires it, where the merge leaves it optional.
        const variant = (name: string) => ({
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' }, [name]: { type: 'string' } },
        });
        const under = await parsed({
          Union: { oneOf: [variant('r'), variant('w')] },
          Plain: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          Holder: { type: 'object', properties: { x: maybe('Plain') } },
          Pet: { allOf: [R('Holder')], properties: { x: maybe('Union') } },
        });
        expect(print(modelNamed(under, 'Pet'))).toBe(
          openapi === '3.0.3' ? 'Pet { x?: Union }' : 'Pet { x?: Union | null }',
        );
        // Two named unions under one field, one of `$ref` variants and one
        // of inline ones: the object fits a variant of `Fielded` and not
        // the merge of them, and carries what `Bare`'s `fields` do — none —
        // without being one of its variants. An emitter that writes a
        // union as its `fields` when it has any, and as its variants when
        // it has none, types the object as neither.
        const mixed = await parsed({
          Leaf: { type: 'object', properties: { x: { type: 'string' } } },
          Bare: { oneOf: [R('Leaf'), { type: 'string' }] },
          Fielded: Shape,
          Holder: { type: 'object', properties: { f: { oneOf: [R('Bare'), R('Fielded')] } } },
          Pet: {
            allOf: [R('Holder')],
            properties: { f: { type: 'object', properties: { r: pinned('a'), w: { type: 'string' } } } },
          },
        });
        expect(print(modelNamed(mixed, 'Pet'))).toBe('Pet { f?: PetF }');
        expect(print(modelNamed(mixed, 'PetF'))).toBe('PetF { r?: "a", w?: string }');
        // A union of nothing.
        const empty = await parsed({
          Empty: { oneOf: [] },
          Animal: { type: 'object', required: ['v'], properties: { v: { type: 'integer' } } },
          Pet: { allOf: [R('Animal')], properties: { v: R('Empty') } },
        });
        expect(print(modelNamed(empty, 'Pet'))).toBe('Pet { v: Empty }');
        if (openapi === '3.1.0') {
          const nothing = await parsed({
            Nothing: { oneOf: [{ type: 'null' }] },
            Animal: { type: 'object', properties: { v: { type: ['string', 'null'] } } },
            Pet: { allOf: [R('Animal')], properties: { v: R('Nothing') } },
          });
          expect(print(modelNamed(nothing, 'Pet'))).toBe('Pet { v?: Nothing | null }');
        }
      });

      it('an array narrowed in its items drops the base, as a declaration with a looser limit or another format does', async () => {
        const Named = { type: 'object', properties: { name: { type: 'string' } } };
        const narrowed = await parsed({
          Named,
          Dog: { allOf: [R('Named')], properties: { bark: { type: 'string' } } },
          Animal: {
            type: 'object',
            properties: {
              friends: { type: 'array', items: R('Named') },
              tags: { type: 'array', items: kindEnum },
              name: { type: 'string' },
            },
          },
          Friendly: { allOf: [R('Animal')], properties: { friends: { type: 'array', items: R('Dog') } } },
          Tagged: { allOf: [R('Animal')], properties: { tags: { type: 'array', items: pinned('cat') } } },
          Pet: { allOf: [R('Animal')], properties: { tags: { type: 'array', items: kindEnum, maxItems: 3 } } },
        });
        const printed = Object.fromEntries(narrowed.models.map((m) => [m.name, print(m)]));
        expect(printed).toMatchObject({
          // `Dog[]` over `Named[]`: the items are `Dog` (#733; `FriendlyFriend`, a copy of it).
          Friendly: 'Friendly { friends?: Dog[], tags?: FriendlyTags[], name?: string }',
          Tagged: 'Tagged { tags?: "cat"[], friends?: Named[], name?: string }',
          // The same items under a tighter limit is the same array to a type.
          Pet: 'Pet : Animal { tags?: PetTags[], friends?: Named[] <- Animal, name?: string <- Animal }',
        });
        // By the rule, where the base stayed before: the model's `name`
        // has no `maxLength`, and an enum is not read under a `format`.
        expect(
          await pet({
            Animal: { type: 'object', properties: { name: { type: 'string', maxLength: 50 } } },
            Pet: { allOf: [R('Animal')], properties: { name: { type: 'string', description: 'Its own.' } } },
          }),
        ).toBe('Pet { name?: string }');
        expect(
          await pet({
            Animal: { type: 'object', properties: { code: { type: 'integer', format: 'int32' } } },
            Pet: { allOf: [R('Animal')], properties: { code: { type: 'integer', format: 'int32', enum: [1, 2] } } },
          }),
        ).toBe('Pet { code?: PetCode }');
      });

      it('reads unions that share their variants once each, wherever the field names them', async () => {
        // `U<i>: anyOf [U<i+1>, U<i+2>]`, forty levels, the last two of
        // `leaves`: one component a level, and as many paths through them
        // as the Fibonacci numbers count. Read path by path, none of these
        // would end.
        const levels = 40;
        const unions = (leaves: [unknown, unknown], prefix = 'U'): Record<string, unknown> => {
          const schemas: Record<string, unknown> = {};
          for (let level = 0; level < levels; level++) {
            schemas[`${prefix}${level}`] =
              level >= levels - 2
                ? { anyOf: leaves }
                : { anyOf: [R(`${prefix}${level + 1}`), R(`${prefix}${level + 2}`)] };
          }
          return schemas;
        };
        const text = { type: 'string' };
        const strings: [unknown, unknown] = [
          { type: 'string', maxLength: 5 },
          { type: 'string', maxLength: 6 },
        ];
        const on = async (theirs: unknown, own: unknown, components: Record<string, unknown>) =>
          pet({
            ...components,
            Animal: { type: 'object', properties: { value: theirs, other: text } },
            Pet: { allOf: [R('Animal')], properties: { value: own } },
          });
        // Greptile's document: the unions type the model's field, over a
        // base's string. Each variant is a string; the merge of them an
        // emitter may write from `fields` is none, so the base goes.
        expect(await on(text, R('U0'), unions(strings))).toBe('Pet { value?: U0, other?: string }');
        // The unions as the base's type, under a string of the model's own.
        expect(await on(R('U0'), { type: 'string', maxLength: 4 }, unions(strings))).toBe(
          'Pet { value?: string, other?: string }',
        );
        // Shared unions on both sides: every string of the one is one of the other's.
        const both = { ...unions(strings), ...unions([text, { type: 'integer' }], 'W') };
        expect(await on(R('W0'), R('U0'), both)).toBe('Pet : Animal { value?: U0, other?: string <- Animal }');
        expect(await on(R('U0'), R('W0'), both)).toBe('Pet { value?: W0, other?: string }');
        // Under a map, and among the variants of an inline union.
        expect(
          await on(
            { type: 'object', additionalProperties: R('W0') },
            { type: 'object', additionalProperties: R('U0') },
            both,
          ),
        ).toBe('Pet : Animal { value?: { [key]: U0 }, other?: string <- Animal }');
        expect(
          await on({ oneOf: [R('W0'), { type: 'boolean' }] }, { oneOf: [R('U0'), R('U1'), { type: 'boolean' }] }, both),
        ).toBe('Pet : Animal { value?: U0 | U1 | boolean, other?: string <- Animal }');
        // Unions of models, under a union of the models they are built on:
        // every leaf is a pair of models, each settled once.
        const Named = { type: 'object', properties: { name: text } };
        const models = {
          Named,
          Cat: { allOf: [R('Named')], properties: { meow: text } },
          Dog: { allOf: [R('Named')], properties: { bark: text } },
          ...unions([R('Cat'), R('Dog')]),
          ...unions([R('Named'), text], 'W'),
        };
        expect(await on(R('W0'), R('U0'), models)).toBe('Pet : Animal { value?: U0, other?: string <- Animal }');
        // A model whose field the unions type, compared as a nested model.
        const nested = await parsed({
          ...both,
          Inner: { type: 'object', properties: { value: R('W0') } },
          Mine: { type: 'object', properties: { value: R('U0') } },
          Holder: { type: 'object', properties: { inner: { oneOf: [R('Inner'), { type: 'integer' }] } } },
          Pet: { allOf: [R('Holder')], properties: { inner: R('Mine') } },
        });
        expect(print(modelNamed(nested, 'Pet'))).toBe('Pet : Holder { inner?: Mine }');
      });

      it('an enum fits a union when each of its values fits a variant', async () => {
        const either = { oneOf: [{ type: 'string' }, { type: 'integer' }] };
        const on = async (theirs: unknown, own: unknown) =>
          pet({
            Animal: { type: 'object', properties: { v: theirs, name: { type: 'string' } } },
            Pet: { allOf: [R('Animal')], properties: { v: own } },
          });
        expect(await on(either, { enum: ['a', 1] })).toBe('Pet : Animal { v?: PetV, name?: string <- Animal }');
        expect(await on(either, { enum: ['a', 1.5] })).toBe('Pet { v?: PetV, name?: string }');
        if (openapi === '3.1.0') {
          expect(await on({ type: ['string', 'integer'] }, { enum: ['a', 1] })).toBe(
            'Pet : Animal { v?: PetV, name?: string <- Animal }',
          );
          expect(await on({ oneOf: [{ const: 'cat' }, { const: 'dog' }] }, { enum: ['cat', 'dog'] })).toBe(
            'Pet : Animal { v?: PetV, name?: string <- Animal }',
          );
        }
      });

      it('a declaration that fits two bases keeps both, one that fits neither drops both', async () => {
        // `'cat'` is one of `Kinded`'s values and one of `Tagged`'s strings.
        expect(await pet({ Tagged, Kinded, Pet: { allOf: bothBases, properties: { tag: pinned('cat') } } })).toBe(
          'Pet : Tagged & Kinded { tag?: "cat", kind?: string <- Kinded }',
        );
        // An integer is neither.
        expect(await pet({ Tagged, Kinded, Pet: { allOf: bothBases, properties: { tag: { type: 'integer' } } } })).toBe(
          'Pet { tag?: integer, kind?: string }',
        );
      });

      it('fields stay as they are, a base that leaves is no longer chased for emission, and oagen diff reports nothing for it', async () => {
        const widen = {
          Animal,
          Pet: { allOf: [R('Animal')], properties: { species: { type: 'string', description: 'Any species.' } } },
        };
        const spec = await parsed(widen);
        // The same `Pet`, declaring every field itself.
        const flat = await parsed({
          Animal,
          Pet: {
            type: 'object',
            properties: { species: { type: 'string', description: 'Any species.' }, name: { type: 'string' } },
          },
        });
        expect(modelNamed(spec, 'Pet')).toEqual(modelNamed(flat, 'Pet'));
        expect(collectReferencedNames(spec.services, spec.models).models.has('Animal')).toBe(false);
        // `Pet` narrowing `species` keeps `Animal`: the two documents differ
        // in `bases` and `inheritedFrom` alone, which are provenance.
        const narrow = await parsed({
          Animal,
          Pet: { allOf: [R('Animal')], properties: { species: { ...kindEnum, description: 'Any species.' } } },
        });
        expect(print(modelNamed(narrow, 'Pet'))).toBe('Pet : Animal { species?: PetSpecies, name?: string <- Animal }');
        expect(collectReferencedNames(narrow.services, narrow.models).models.has('Animal')).toBe(true);
        for (const report of [diffSpecs(spec, flat), diffSpecs(flat, spec)]) {
          expect(report.changes).toEqual([]);
          expect(report.behaviorChanges).toEqual([]);
        }
        // Requiring `tag` takes `Kinded` out of `bases` and reports the
        // requirement alone.
        const optional = await parsed({ Tagged, Kinded, Pet: { allOf: bothBases } });
        const required = await parsed({ Tagged, Kinded, Pet: { allOf: bothBases, required: ['tag'] } });
        expect(diffSpecs(optional, required).changes.map((change) => change.kind)).toEqual(['model-modified']);
        expect(JSON.stringify(diffSpecs(optional, required).changes)).not.toContain('bases');
      });
    });
  }

  describe('settleBases', () => {
    const field = (name: string, extra: Partial<Field> = {}): Field => ({
      name,
      type: string,
      required: false,
      ...extra,
    });
    const outline = (m: Model) => ({ bases: m.bases, inherited: m.fields.map((f) => f.inheritedFrom) });
    const kept = { bases: [model('Animal')], inherited: [undefined, model('Animal')] };
    const dropped = { bases: undefined, inherited: [undefined, undefined] };
    /** `Pet { value (own), tail <- Animal }` over `Animal { value: theirs, tail }`. */
    const over = (own: Partial<Field>, theirs: Partial<Field>, more: Model[] = [], enums: Enum[] = []) => {
      const pet: Model = {
        name: 'Pet',
        fields: [field('value', own), field('tail', { inheritedFrom: model('Animal') })],
        bases: [model('Animal')],
      };
      settleBases([{ name: 'Animal', fields: [field('value', theirs), field('tail')] }, pet, ...more], enums);
      return outline(pet);
    };
    const enumOf = (name: string, values: Array<string | number>): Enum => ({
      name,
      values: values.map((value) => ({ name: String(value).toUpperCase(), value })),
    });

    it('reads requiredness one way: required fits optional, optional does not fit required', () => {
      expect(over({ required: true }, {})).toEqual(kept);
      expect(over({ required: true }, { required: true })).toEqual(kept);
      expect(over({}, {})).toEqual(kept);
      expect(over({}, { required: true })).toEqual(dropped);
    });

    it('reads a component enum through the document’s enums, and one it cannot read as no fit', () => {
      const kind: TypeRef = { kind: 'enum', name: 'Kind' };
      const small: TypeRef = { kind: 'enum', name: 'SmallKind' };
      const enums = [enumOf('Kind', ['cat', 'dog', 'bird']), enumOf('SmallKind', ['cat', 'dog'])];
      expect(over({ type: small }, { type: kind }, [], enums)).toEqual(kept);
      expect(over({ type: kind }, { type: small }, [], enums)).toEqual(dropped);
      expect(over({ type: small }, {}, [], enums)).toEqual(kept);
      expect(over({ type: { kind: 'literal', value: 'cat' } }, { type: small }, [], enums)).toEqual(kept);
      expect(over({ type: { kind: 'literal', value: 'bird' } }, { type: small }, [], enums)).toEqual(dropped);
      // An inline enum beside a component one, by their values.
      expect(over({ type: { kind: 'enum', name: 'PetValue', values: ['cat'] } }, { type: small }, [], enums)).toEqual(
        kept,
      );
      expect(
        over({ type: small }, { type: { kind: 'enum', name: 'AnimalValue', values: ['cat'] } }, [], enums),
      ).toEqual(dropped);
      // Without the enums, a component enum is read by its name alone.
      expect(over({ type: small }, { type: kind })).toEqual(dropped);
      expect(over({ type: small }, {})).toEqual(dropped);
      expect(over({ type: kind }, { type: kind })).toEqual(kept);
    });

    it('reads nullability through every wrapper', () => {
      const maybe = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });
      const nothing: TypeRef = { kind: 'literal', value: null };
      expect(over({}, { type: maybe(string) })).toEqual(kept);
      expect(over({}, { type: maybe(maybe(string)) })).toEqual(kept);
      expect(over({ type: maybe(maybe(string)) }, { type: maybe(string) })).toEqual(kept);
      expect(over({ type: nothing }, { type: maybe(string) })).toEqual(kept);
      expect(over({ type: maybe(string) }, { type: { kind: 'union', variants: [string, nothing] } })).toEqual(kept);
      expect(over({ type: maybe(string) }, {})).toEqual(dropped);
      expect(over({ type: maybe(maybe(string)) }, {})).toEqual(dropped);
      expect(over({ type: nothing }, {})).toEqual(dropped);
      expect(over({ type: maybe(string) }, { type: { kind: 'primitive', type: 'unknown' } })).toEqual(kept);
    });

    it('reads limits as bounds: an exclusive bound beside an inclusive one, any other keyword the same', () => {
      const number = (constraints?: Field['constraints']): Partial<Field> => ({
        type: { kind: 'primitive', type: 'number', ...(constraints ? { constraints } : {}) },
        ...(constraints ? { constraints } : {}),
      });
      expect(over(number({ maximum: 5 }), number({ maximum: 5 }))).toEqual(kept);
      expect(over(number({ maximum: 5 }), number({ exclusiveMaximum: 6 }))).toEqual(kept);
      expect(over(number({ maximum: 6 }), number({ exclusiveMaximum: 6 }))).toEqual(dropped);
      expect(over(number({ exclusiveMaximum: 5 }), number({ maximum: 5 }))).toEqual(kept);
      expect(over(number({ exclusiveMaximum: 6 }), number({ maximum: 5 }))).toEqual(dropped);
      expect(over(number({ minimum: 1 }), number({ exclusiveMinimum: 0 }))).toEqual(kept);
      expect(over(number({ minimum: 0 }), number({ exclusiveMinimum: 0 }))).toEqual(dropped);
      expect(over(number({ exclusiveMinimum: 0 }), number({ minimum: 0 }))).toEqual(kept);
      expect(over(number({ exclusiveMinimum: -1 }), number({ minimum: 0 }))).toEqual(dropped);
      expect(over(number({ multipleOf: 2 }), number({ multipleOf: 2 }))).toEqual(kept);
      expect(over(number({ multipleOf: 4 }), number({ multipleOf: 2 }))).toEqual(dropped);
      expect(over(number(), number({ multipleOf: 2 }))).toEqual(dropped);
      // A pinned value or an enum's is read against each bound it can be.
      const five: Partial<Field> = { type: { kind: 'literal', value: 5 } };
      expect(over(five, number({ minimum: 5, maximum: 5 }))).toEqual(kept);
      expect(over(five, number({ exclusiveMaximum: 5 }))).toEqual(dropped);
      expect(over(five, number({ exclusiveMinimum: 5 }))).toEqual(dropped);
      expect(over(five, number({ multipleOf: 5 }))).toEqual(dropped);
      // An array's and a map's own limits, at the level that carries them.
      const list = (constraints?: Field['constraints'], items: TypeRef = string): Partial<Field> => ({
        type: { kind: 'array', items, ...(constraints ? { constraints } : {}) },
        ...(constraints ? { constraints } : {}),
      });
      expect(over(list({ maxItems: 3, uniqueItems: true }), list({ maxItems: 5 }))).toEqual(kept);
      expect(over(list({ maxItems: 5 }), list({ maxItems: 5, uniqueItems: true }))).toEqual(dropped);
      expect(over(list({ maxItems: 6 }), list({ maxItems: 5 }))).toEqual(dropped);
      expect(over(list({ minItems: 1 }), list({ minItems: 2 }))).toEqual(dropped);
      const short: TypeRef = { kind: 'primitive', type: 'string', constraints: { maxLength: 2 } };
      const long: TypeRef = { kind: 'primitive', type: 'string', constraints: { maxLength: 9 } };
      // An array fits only an array of the same items: narrower items are
      // not what an intersection types, whichever way the limits go.
      expect(over(list(undefined, short), list(undefined, long))).toEqual(dropped);
      expect(over(list(undefined, long), list(undefined, short))).toEqual(dropped);
      expect(over(list({ maxItems: 2 }, short), list({ maxItems: 3 }, short))).toEqual(kept);
      expect(over(list(undefined, { kind: 'literal', value: 'cat' }), list())).toEqual(dropped);
      expect(over({ type: { kind: 'map', valueType: short } }, { type: { kind: 'map', valueType: long } })).toEqual(
        kept,
      );
      expect(over({ type: { kind: 'map', valueType: long } }, { type: { kind: 'map', valueType: short } })).toEqual(
        dropped,
      );
      // The field's own limits count where its type carries none: a reference.
      const owner = (constraints?: Field['constraints']): Partial<Field> => ({
        type: model('Owner'),
        ...(constraints ? { constraints } : {}),
      });
      const more: Model[] = [{ name: 'Owner', fields: [] }];
      expect(over(owner({ minProperties: 2 }), owner({ minProperties: 1 }), more)).toEqual(kept);
      expect(over(owner(), owner({ minProperties: 1 }), more)).toEqual(dropped);
      expect(over(owner({ minProperties: 1 }), owner(), more)).toEqual(kept);
    });

    it('settles every comparison with a named union once: shared, under maps, nullable, recursive, and as a base', () => {
      const integer: TypeRef = { kind: 'primitive', type: 'integer' };
      const named = (name: string): ModelRef => {
        const ref = model(name);
        markComponentModelRef(ref);
        return ref;
      };
      const union = (name: string, variants: TypeRef[]): Model => ({
        name,
        fields: [],
        variants,
        compositionKind: 'anyOf',
      });
      const maybe = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });
      const map = (valueType: TypeRef): TypeRef => ({ kind: 'map', valueType });
      const levels = 60;
      /** `<prefix><i>: anyOf [wrap(<prefix><i+1>), wrap(<prefix><i+2>)]`, the last two of `leaves`. */
      const shared = (prefix: string, leaves: TypeRef[], wrap: (ref: TypeRef) => TypeRef = (ref) => ref): Model[] =>
        Array.from({ length: levels }, (_, level) =>
          union(
            `${prefix}${level}`,
            level >= levels - 2 ? leaves : [wrap(named(`${prefix}${level + 1}`)), wrap(named(`${prefix}${level + 2}`))],
          ),
        );
      const cat: Model = { name: 'Cat', fields: [field('name', { required: true }), field('meow')] };
      const dog: Model = { name: 'Dog', fields: [field('name', { required: true }), field('bark')] };
      const plain: Model = { name: 'Named', fields: [field('name')] };
      const wide = shared('W', [string, integer, named('Named')]);
      const all = (...unions: Model[][]) => [cat, dog, plain, ...wide, ...unions.flat()];
      // Sixty unions, each the union of the next two: as many paths as the
      // sixtieth Fibonacci number, each union read once.
      expect(over({ type: named('U0') }, { type: named('W0') }, all(shared('U', [string])))).toEqual(kept);
      expect(
        over({ type: named('U0') }, { type: named('W0') }, all(shared('U', [named('Cat'), named('Dog')]))),
      ).toEqual(kept);
      const boolean: TypeRef = { kind: 'primitive', type: 'boolean' };
      expect(over({ type: named('U0') }, { type: named('W0') }, all(shared('U', [string, boolean])))).toEqual(dropped);
      // The same under nullable wrappers, which add `null` to what the union admits.
      const nullables = all(shared('U', [string], maybe));
      expect(over({ type: named('U0') }, { type: named('W0') }, nullables)).toEqual(dropped);
      expect(over({ type: named('U0') }, { type: maybe(named('W0')) }, nullables)).toEqual(kept);
      expect(
        over({ type: maybe(named('U0')) }, { type: maybe(named('W0')) }, all(shared('U', [string, integer]))),
      ).toEqual(kept);
      // Under maps: `M<i>: anyOf [map<M<i+1>>, map<M<i+2>>]` against the
      // same shape on the base's side, which reaches every pair of levels.
      const maps = (prefix: string, leaf: TypeRef) => shared(prefix, [leaf, map(leaf)], map);
      expect(over({ type: named('M0') }, { type: named('N0') }, all(maps('M', string), maps('N', string)))).toEqual(
        kept,
      );
      expect(over({ type: named('M0') }, { type: named('N0') }, all(maps('M', integer), maps('N', string)))).toEqual(
        dropped,
      );
      // Unions that reach themselves through a map of themselves are
      // settled together, as models that reach each other are.
      const json = (name: string, leaf: TypeRef) => union(name, [leaf, map(named(name))]);
      const recursive = [json('Json', string), json('Wider', string), json('Other', integer)];
      expect(over({ type: named('Json') }, { type: named('Wider') }, recursive)).toEqual(kept);
      expect(over({ type: named('Json') }, { type: named('Other') }, recursive)).toEqual(dropped);
      // A map is one of `Wider`'s variants, and no model: read as the merge of its variants, `Wider` is one.
      expect(over({ type: map(string) }, { type: named('Wider') }, recursive)).toEqual(dropped);
      // A union that names itself with nothing between admits what its other variants do, and no more.
      const loops = [union('Loop', [named('Loop'), maybe(named('Loop')), string]), union('Strings', [string, integer])];
      expect(over({ type: named('Loop') }, { type: maybe(named('Strings')) }, loops)).toEqual(kept);
      expect(over({ type: named('Loop') }, { type: named('Strings') }, loops)).toEqual(dropped);
      expect(over({ type: integer }, { type: named('Loop') }, loops)).toEqual(dropped);
      // The shared unions as a base: its variants' fields are read once
      // each, and one of them has to agree with the model.
      const based = (fields: Field[]): Model => ({ name: 'Pet', fields, bases: [model('U0')] });
      const agreeing = based([field('name', { required: true }), field('extra')]);
      const contradicting = based([field('name', { type: integer }), field('extra')]);
      settleBases([cat, dog, ...shared('U', [named('Cat'), named('Dog')]), agreeing, contradicting]);
      expect(agreeing.bases?.map(refName)).toEqual(['U0']);
      expect(contradicting.bases).toBeUndefined();
    });

    it('reads a union or an enum of nothing as fitting nothing, and two chains of four thousand models without recursing', () => {
      const nothing: TypeRef = { kind: 'union', variants: [] };
      const noValues: TypeRef = { kind: 'enum', name: 'PetValue', values: [] };
      expect(over({ type: nothing }, {})).toEqual(dropped);
      expect(over({ type: noValues }, {})).toEqual(dropped);
      expect(over({ type: nothing }, { type: nothing })).toEqual(kept);
      expect(over({}, { type: nothing })).toEqual(dropped);
      // A named union of nothing is no base, whatever the model carries.
      const pet: Model = { name: 'Pet', fields: [field('extra')], bases: [model('Empty')] };
      settleBases([{ name: 'Empty', fields: [], variants: [], compositionKind: 'oneOf' }, pet]);
      expect(pet.bases).toBeUndefined();
      // Components: `Own<i>.next: Own<i+1>` over `Base<i>.next: Base<i+1>`.
      const named = (name: string): ModelRef => {
        const ref = model(name);
        markComponentModelRef(ref);
        return ref;
      };
      const length = 4000;
      const chain = (prefix: string, last: Field[]): Model[] =>
        Array.from({ length }, (_, index) => ({
          name: `${prefix}${index}`,
          fields: index === length - 1 ? last : [field('next', { type: named(`${prefix}${index + 1}`) })],
        }));
      const chains = (last: Field[]) => [...chain('Own', last), ...chain('Base', [field('x')])];
      expect(over({ type: named('Own0') }, { type: named('Base0') }, chains([field('x', { required: true })]))).toEqual(
        kept,
      );
      expect(over({ type: named('Own0') }, { type: named('Base0') }, chains([]))).toEqual(dropped);
    });

    it('reads an untyped schema as fitting nothing but itself, and as fit by anything', () => {
      const untyped: TypeRef = { kind: 'primitive', type: 'unknown' };
      expect(over({ type: untyped }, { type: untyped })).toEqual(kept);
      expect(over({ type: untyped }, {})).toEqual(dropped);
      expect(over({}, { type: untyped })).toEqual(kept);
      expect(over({ type: { kind: 'array', items: model('Owner') } }, { type: untyped })).toEqual(kept);
      // With limits of its own it is no longer every value's type.
      const limited: TypeRef = { kind: 'primitive', type: 'unknown', constraints: { maxLength: 3 } };
      expect(over({}, { type: limited, constraints: { maxLength: 3 } })).toEqual(dropped);
      expect(
        over({ type: { kind: 'literal', value: 'cat' } }, { type: limited, constraints: { maxLength: 3 } }),
      ).toEqual(kept);
      expect(
        over({ type: { kind: 'literal', value: 'bird' } }, { type: limited, constraints: { maxLength: 3 } }),
      ).toEqual(dropped);
    });

    it('takes a field the SDK exposes under another name as another property', () => {
      expect(over({ domainName: 'kind' }, { domainName: 'kind' })).toEqual(kept);
      expect(over({ domainName: 'kind' }, {})).toEqual(dropped);
      expect(over({}, { domainName: 'kind' })).toEqual(dropped);
    });

    it('reads a union with limits of its own, or a map by another key, as itself alone', () => {
      const integer: TypeRef = { kind: 'primitive', type: 'integer' };
      const either = (constraints?: Field['constraints']): TypeRef => ({
        kind: 'union',
        variants: [string, integer],
        ...(constraints ? { constraints } : {}),
      });
      expect(over({}, { type: either() })).toEqual(kept);
      expect(over({ type: either() }, { type: { kind: 'union', variants: [integer, string] } })).toEqual(kept);
      expect(over({}, { type: either({ maxLength: 3 }), constraints: { maxLength: 3 } })).toEqual(dropped);
      expect(
        over(
          { type: either({ maxLength: 3 }), constraints: { maxLength: 3 } },
          { type: { kind: 'union', variants: [string, integer, { kind: 'primitive', type: 'boolean' }] } },
        ),
      ).toEqual(dropped);
      const map = (keyType?: TypeRef, valueType: TypeRef = string): TypeRef => ({
        kind: 'map',
        valueType,
        ...(keyType ? { keyType } : {}),
      });
      expect(over({ type: map(string) }, { type: map(string) })).toEqual(kept);
      expect(over({ type: map(string, { kind: 'literal', value: 'cat' }) }, { type: map(string) })).toEqual(kept);
      expect(over({ type: map(string) }, { type: map() })).toEqual(dropped);
      expect(over({ type: map() }, { type: map(string) })).toEqual(dropped);
    });

    it('reads a reference to a model by the fields the models end with, whatever the order of the models', () => {
      const component = (name: string): ModelRef => {
        const ref = model(name);
        markComponentModelRef(ref);
        return ref;
      };
      // `Puppy` carries `Named`'s `name` through `Dog`: a `Puppy` fits a
      // `Named`. `Stray` redeclares `name` as nullable, so it is not on
      // `Named` and does not fit one: `Litter`, typing `friend` as `Stray`,
      // is not on `Holder`, and `Kennel`, typing `home` as `Litter`, is
      // then not on `Shelter` either — read from the fields alone, so no
      // model has to be settled before another.
      const build = (): Model[] => [
        { name: 'Named', fields: [field('name', { required: true })] },
        {
          name: 'Dog',
          fields: [field('name', { required: true, inheritedFrom: model('Named') })],
          bases: [model('Named')],
        },
        {
          name: 'Puppy',
          fields: [field('name', { required: true, inheritedFrom: model('Dog') })],
          bases: [model('Dog')],
        },
        {
          name: 'Stray',
          fields: [field('name', { required: true, type: { kind: 'nullable', inner: string } })],
          bases: [model('Named')],
        },
        { name: 'Holder', fields: [field('friend', { type: component('Named') })] },
        { name: 'Pack', fields: [field('friend', { type: component('Puppy') })], bases: [model('Holder')] },
        { name: 'Litter', fields: [field('friend', { type: component('Stray') })], bases: [model('Holder')] },
        { name: 'Shelter', fields: [field('home', { type: component('Holder') })] },
        { name: 'Kennel', fields: [field('home', { type: component('Litter') })], bases: [model('Shelter')] },
        { name: 'Yard', fields: [field('home', { type: component('Pack') })], bases: [model('Shelter')] },
      ];
      for (const models of [build(), build().reverse()]) {
        settleBases(models);
        const bases = Object.fromEntries(models.map((m) => [m.name, m.bases?.map(refName)]));
        expect(bases).toEqual({
          Named: undefined,
          Dog: ['Named'],
          Puppy: ['Dog'],
          Stray: undefined,
          Holder: undefined,
          Pack: ['Holder'],
          Litter: undefined,
          Shelter: undefined,
          Kennel: undefined,
          Yard: ['Shelter'],
        });
      }
    });

    it('reads a named union each way an emitter writes it, ends on a pair of models that reach each other, and reads a dispatcher as itself alone', () => {
      const integer: TypeRef = { kind: 'primitive', type: 'integer' };
      const named = (name: string): ModelRef => {
        const ref = model(name);
        markComponentModelRef(ref);
        return ref;
      };
      // A named union is its variants to one emitter and the merge of them
      // (`fields`) to another: a fit has to hold under both. `Shape`'s
      // variants are references, so it carries no field: `Cat` is one of
      // its variants, `Bird` is not. `Merged` carries its inline variants'
      // fields: `Quiet` fits a variant and carries the merge; `Loud` fits
      // the same variant and types the merge's `bark` otherwise; `Cat`
      // fits it too and does not carry `bark` at all.
      const cat: Model = { name: 'Cat', fields: [field('meow')] };
      const dog: Model = { name: 'Dog', fields: [field('bark', { required: true })] };
      const bird: Model = { name: 'Bird', fields: [field('sing')] };
      const shape: Model = {
        name: 'Shape',
        fields: [],
        variants: [named('Cat'), named('Dog')],
        compositionKind: 'oneOf',
      };
      const merged: Model = {
        name: 'Merged',
        fields: [field('meow'), field('bark', { type: integer })],
        variants: [model('MergedWithMeow'), model('MergedWithBark')],
        compositionKind: 'oneOf',
      };
      const loop: Model = { name: 'Loop', fields: [], variants: [named('Loop'), string], compositionKind: 'oneOf' };
      const unions = [
        cat,
        dog,
        bird,
        shape,
        merged,
        loop,
        { name: 'MergedWithMeow', fields: [field('meow')] },
        { name: 'MergedWithBark', fields: [field('bark', { type: integer })] },
        { name: 'Loud', fields: [field('meow'), field('bark')] },
        { name: 'Quiet', fields: [field('meow'), field('bark', { type: integer })] },
      ];
      expect(over({ type: named('Cat') }, { type: named('Shape') }, unions)).toEqual(kept);
      expect(over({ type: named('Bird') }, { type: named('Shape') }, unions)).toEqual(dropped);
      expect(over({ type: named('Shape') }, { type: named('Cat') }, unions)).toEqual(dropped);
      expect(over({ type: named('Shape') }, { type: named('Shape') }, unions)).toEqual(kept);
      expect(over({ type: named('Quiet') }, { type: named('Merged') }, unions)).toEqual(kept);
      expect(over({ type: named('Loud') }, { type: named('Merged') }, unions)).toEqual(dropped);
      expect(over({ type: named('Cat') }, { type: named('Merged') }, unions)).toEqual(dropped);
      // A union that names itself is met again against the same type, and is no fit there.
      expect(over({ type: integer }, { type: named('Loop') }, unions)).toEqual(dropped);
      expect(over({ type: named('Loop') }, {}, unions)).toEqual(dropped);
      expect(over({ type: named('Loop') }, { type: named('Loop') }, unions)).toEqual(kept);
      expect(
        over({ type: named('Shape') }, { type: { kind: 'union', variants: [integer, named('Shape')] } }, unions),
      ).toEqual(kept);
      expect(over({ type: named('Shape') }, { type: { kind: 'primitive', type: 'unknown' } }, unions)).toEqual(kept);
      // A named union with limits of its own, or with no variant, is read as itself alone.
      const limited: Model = { ...shape, name: 'Limited', constraints: { minProperties: 1 } };
      const empty: Model = { name: 'Empty', fields: [], variants: [], compositionKind: 'oneOf' };
      expect(over({ type: named('Cat') }, { type: named('Limited') }, [...unions, limited])).toEqual(dropped);
      expect(over({ type: named('Cat') }, { type: named('Empty') }, [...unions, empty])).toEqual(dropped);
      expect(over({ type: named('Empty') }, {}, [...unions, empty])).toEqual(dropped);
      // `Left { peer: Right }` over `Wide { peer: Wider }`, `Right { peer:
      // Left, extra }` over `Wider { peer: Wide }`: each pair is met again
      // on the way and taken to fit; a field that does not fit still answers.
      const pair = (extra: Partial<Field>): Model[] => [
        { name: 'Left', fields: [field('peer', { type: named('Right') })] },
        { name: 'Right', fields: [field('peer', { type: named('Left') }), field('extra', extra)] },
        { name: 'Wide', fields: [field('peer', { type: named('Wider') })] },
        { name: 'Wider', fields: [field('peer', { type: named('Wide') }), field('extra')] },
      ];
      expect(over({ type: named('Left') }, { type: named('Wide') }, pair({ required: true }))).toEqual(kept);
      expect(over({ type: named('Left') }, { type: named('Wide') }, pair({ type: integer }))).toEqual(dropped);
      // A pair that did not fit under one variant is read again under the
      // next: `Holder { a: Part, b: Part }` fits neither `First { a: Whole }`
      // nor `Second { b: Whole }`, since `Part` lacks `Whole`'s `need`.
      const parts = (part: Field[]): Model[] => [
        { name: 'Holder', fields: [field('a', { type: named('Part') }), field('b', { type: named('Part') })] },
        { name: 'First', fields: [field('a', { type: named('Whole') })] },
        { name: 'Second', fields: [field('b', { type: named('Whole') })] },
        { name: 'Part', fields: part },
        { name: 'Whole', fields: [field('need')] },
      ];
      const either: TypeRef = { kind: 'union', variants: [named('First'), named('Second')] };
      expect(over({ type: named('Holder') }, { type: either }, parts([]))).toEqual(dropped);
      expect(over({ type: named('Holder') }, { type: either }, parts([field('need', { required: true })]))).toEqual(
        kept,
      );
      // A dispatcher's `fields` are not the whole of a variant.
      const plain: Model = { name: 'Plain', fields: [field('id')] };
      const dispatcher: Model = {
        name: 'Dispatcher',
        fields: [field('id')],
        discriminator: { property: 'kind', mapping: { cat: 'Cat' } },
      };
      expect(over({ type: named('Dispatcher') }, { type: named('Plain') }, [plain, dispatcher])).toEqual(dropped);
      expect(over({ type: named('Plain') }, { type: named('Dispatcher') }, [plain, dispatcher])).toEqual(dropped);
      expect(over({ type: named('Dispatcher') }, { type: named('Dispatcher') }, [plain, dispatcher])).toEqual(kept);
    });

    it('keeps the base under a declaration that only requires, documents or deprecates the base’s field, whatever it declares', () => {
      const primitive = (type: 'string' | 'number' | 'integer' | 'unknown', extra: object = {}): TypeRef => ({
        kind: 'primitive',
        type,
        ...extra,
      });
      const inline = (values: Array<string | number>): TypeRef => ({ kind: 'enum', name: 'Inline', values });
      const maybe = (inner: TypeRef): TypeRef => ({ kind: 'nullable', inner });
      const consts: TypeRef[] = [
        { kind: 'literal', value: 'a' },
        { kind: 'literal', value: 1 },
      ];
      const more: Model[] = [
        { name: 'Plain', fields: [field('x')] },
        { name: 'Limited', fields: [field('x')], constraints: { minProperties: 1 } },
        {
          name: 'Dispatcher',
          fields: [field('kind')],
          discriminator: { property: 'kind', mapping: { plain: 'Plain' } },
        },
        { name: 'Union', fields: [], variants: [model('Plain'), string], compositionKind: 'oneOf' },
        { name: 'Self', fields: [field('next', { type: model('Self') })] },
      ];
      const enums = [enumOf('Kind', ['a', 'b'])];
      // [label, type, the field's own limits]
      const declarations: Array<[string, TypeRef, Field['constraints']?]> = [
        ['string', string],
        ['a pattern', primitive('string', { constraints: { pattern: '^a' } }), { pattern: '^a' }],
        ['a format', primitive('string', { format: 'date-time' })],
        ['multipleOf', primitive('number', { constraints: { multipleOf: 0.5 } }), { multipleOf: 0.5 }],
        [
          'bounds',
          primitive('integer', { constraints: { minimum: 0, exclusiveMaximum: 9 } }),
          { minimum: 0, exclusiveMaximum: 9 },
        ],
        ['untyped', primitive('unknown')],
        ['untyped with a limit', primitive('unknown', { constraints: { maxLength: 3 } }), { maxLength: 3 }],
        ['a pinned value', { kind: 'literal', value: 'a' }],
        [
          'a pinned value under a pattern',
          { kind: 'literal', value: 'a', constraints: { pattern: '^a' } },
          { pattern: '^a' },
        ],
        ['a pinned null', { kind: 'literal', value: null }],
        ['an inline enum', inline(['a', 'b'])],
        ['an inline enum under a pattern', inline(['a', 'b']), { pattern: '^[ab]$' }],
        ['an inline enum under multipleOf', inline([2, 4]), { multipleOf: 2 }],
        ['an inline enum of two types under a limit of one', inline(['a', 1]), { minLength: 1 }],
        ['a component enum', { kind: 'enum', name: 'Kind' }],
        ['a component enum under a pattern', { kind: 'enum', name: 'Kind' }, { pattern: '^[ab]$' }],
        ['a component enum nothing lists', { kind: 'enum', name: 'Gone' }],
        ['a nullable enum under a pattern', maybe(inline(['a', 'b'])), { pattern: '^[ab]$' }],
        ['nullable twice', maybe(maybe(string))],
        [
          'an array with limits',
          { kind: 'array', items: string, constraints: { uniqueItems: true } },
          { uniqueItems: true },
        ],
        ['a map', { kind: 'map', valueType: primitive('integer') }],
        ['a union', { kind: 'union', variants: [string, primitive('integer')], compositionKind: 'oneOf' }],
        [
          'a type list with limits',
          { kind: 'union', variants: [string, primitive('integer')], constraints: { maxLength: 3 } },
          { maxLength: 3 },
        ],
        [
          'a union of pinned values under a limit',
          { kind: 'union', variants: consts, constraints: { minLength: 1 } },
          { minLength: 1 },
        ],
        ['a model', model('Plain')],
        ['a model under the field’s limits', model('Plain'), { minProperties: 1 }],
        ['a model with limits', model('Limited')],
        ['a dispatcher', model('Dispatcher')],
        ['a named union', model('Union')],
        ['a model that reaches itself', model('Self')],
        ['a nullable model', maybe(model('Plain'))],
        ['a model nothing declares', model('Gone')],
      ];
      const lost: string[] = [];
      for (const [label, type, constraints] of declarations) {
        const theirs: Partial<Field> = { type, ...(constraints ? { constraints } : {}) };
        const changes: Array<Partial<Field>> = [{ required: true }, { description: 'Its own.' }, { deprecated: true }];
        for (const change of changes) {
          const outcome = over({ ...structuredClone(theirs), ...change }, theirs, structuredClone(more), enums);
          if (!outcome.bases) lost.push(`${label} + ${Object.keys(change)[0]}`);
        }
      }
      expect(lost).toEqual([]);
    });

    it('settles models that reach each other together, each pair once', () => {
      const named = (name: string): ModelRef => {
        const ref = model(name);
        markComponentModelRef(ref);
        return ref;
      };
      // Two families of twelve models, each model naming every other of its
      // family: `Own3.f5: Own5` over `Base3.f5: Base5`. Every pair depends
      // on every other, so one field that does not fit, anywhere, leaves no
      // pair fitting — and read path by path this would not end.
      const size = 12;
      const family = (prefix: string, last: Partial<Field>): Model[] =>
        Array.from({ length: size }, (_, index) => ({
          name: `${prefix}${index}`,
          fields: [
            field('x', index === size - 1 ? last : {}),
            ...Array.from({ length: size }, (_, other) => other)
              .filter((other) => other !== index)
              .map((other) => field(`f${other}`, { type: named(`${prefix}${other}`) })),
          ],
        }));
      const mesh = (last: Partial<Field>) => [...family('Own', last), ...family('Base', {})];
      expect(over({ type: named('Own0') }, { type: named('Base0') }, mesh({ required: true }))).toEqual(kept);
      expect(
        over({ type: named('Own0') }, { type: named('Base0') }, mesh({ type: { kind: 'primitive', type: 'integer' } })),
      ).toEqual(dropped);
      // Whichever model the question starts from, and in whichever order the models come.
      expect(over({ type: named('Own7') }, { type: named('Base7') }, mesh({ required: true }).reverse())).toEqual(kept);
      expect(
        over(
          { type: named('Own7') },
          { type: named('Base7') },
          mesh({ type: { kind: 'nullable', inner: string } }).reverse(),
        ),
      ).toEqual(dropped);
    });

    it('keeps only the bases the model’s declaration fits, in either order', () => {
      const kinded: TypeRef = { kind: 'enum', name: 'KindedTag', values: ['cat', 'dog'] };
      const tagged: Model = { name: 'Tagged', fields: [field('tag')] };
      const kindedModel: Model = { name: 'Kinded', fields: [field('tag', { type: kinded }), field('kind')] };
      const settle = (tag: Partial<Field>, order: string[]) => {
        const pet: Model = {
          name: 'Pet',
          fields: [field('tag', tag), field('kind', { inheritedFrom: model('Kinded') })],
          bases: order.map(model),
        };
        settleBases([tagged, kindedModel, pet]);
        return { bases: pet.bases?.map(refName), inherited: pet.fields.map((f) => refName(f.inheritedFrom)) };
      };
      for (const order of [
        ['Tagged', 'Kinded'],
        ['Kinded', 'Tagged'],
      ]) {
        // `tagged.json`: a required string fits `Tagged`'s alone.
        expect(settle({ required: true }, order)).toEqual({ bases: ['Tagged'], inherited: [undefined, undefined] });
        // A value of the enum fits both.
        expect(settle({ type: { kind: 'literal', value: 'cat' } }, order)).toEqual({
          bases: order,
          inherited: [undefined, 'Kinded'],
        });
        // An integer fits neither.
        expect(settle({ type: { kind: 'primitive', type: 'integer' } }, order)).toEqual({
          bases: undefined,
          inherited: [undefined, undefined],
        });
      }
    });
  });
});
