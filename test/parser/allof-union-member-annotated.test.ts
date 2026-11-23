import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { classifyInlineSchema, isReadableSchema, schemaToTypeRef } from '../../src/parser/schemas.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import {
  allOfTypingMember,
  carriesUnion,
  declaresInlineProperties,
  readInlineAllOf,
  referencesThroughUnion,
  splicedAllOfMembers,
} from '../../src/parser/inline-models.js';
import { collectResponseHeaders, collectWebhookTypeRefs } from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #732: an inline `allOf` whose one typing member is a `oneOf`/`anyOf`,
 * beside members that only annotate or limit it, was merged into one model
 * whenever a variant of the union was a `$ref` or an inline object: the
 * variants' properties flattened into optional fields, a variant that is no
 * object dropped, and a union of a `$ref` to a primitive component and a
 * primitive a model with no fields — where the lone member, and the same
 * keywords written beside the `allOf`, gave the union. The one member that
 * types an `allOf` is the member the `allOf` is read as, a union included,
 * whatever its variants are.
 */

type Doc = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: 'string' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const object = (properties: Doc, rest: Doc = {}): Doc => ({ type: 'object', properties, ...rest });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
/** The issue's second member. */
const D = { description: 'Who to call.' };

const show = (type: TypeRef | undefined): string => {
  if (!type) return String(type);
  switch (type.kind) {
    case 'union':
      return `(${type.variants.map(show).join(' | ')})${type.discriminator ? ` by ${type.discriminator.property}` : ''}`;
    case 'nullable':
      return `nullable<${show(type.inner)}>`;
    case 'array':
      return `${show(type.items)}[]`;
    case 'map':
      return `map<${show(type.valueType)}>`;
    case 'model':
    case 'enum':
      return type.name;
    case 'literal':
      return JSON.stringify(type.value);
    case 'primitive':
      return type.type;
  }
};

describe.each(['3.1.0', '3.0.3'])(
  '#732 an inline allOf of one union member beside annotating members (OAS %s)',
  (openapi) => {
    let warn: ReturnType<typeof vi.spyOn>;
    let tmpDir: string;
    let written = 0;

    beforeEach(async () => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-732-'));
    });

    afterEach(async () => {
      warn.mockRestore();
      vi.restoreAllMocks();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    async function write(doc: unknown, name = `spec-${written++}.json`): Promise<string> {
      const file = path.join(tmpDir, name);
      await fs.writeFile(file, JSON.stringify(doc), 'utf-8');
      return file;
    }

    /** One document parsed: its IR and the warnings it printed. */
    const read = async (doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> => {
      warn.mockClear();
      const spec = await parseSpec(await write(doc));
      return { spec, warnings: warn.mock.calls.map((call: unknown[]) => String(call[0])) };
    };

    const model = (spec: ApiSpec, name: string): Model => {
      const found = spec.models.find((m) => m.name === name);
      if (!found) throw new Error(`no model ${name} among ${spec.models.map((m) => m.name).join(', ')}`);
      return found;
    };
    const operation = (spec: ApiSpec, name: string): Operation => {
      const found = spec.services.flatMap((s) => s.operations).find((o) => o.name === name);
      if (!found) throw new Error(`no operation ${name}`);
      return found;
    };
    const fieldsOf = (m: Model) => m.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${show(f.type)}`);
    const modelNames = (spec: ApiSpec) => spec.models.map((m) => m.name);

    /** Two documents give one IR, print the same warnings, and `diffSpecs` reports nothing between them. */
    const expectSameReading = async (left: unknown, right: unknown, label?: string) => {
      const a = await read(left);
      const b = await read(right);
      expect(a.spec, label).toEqual(b.spec);
      expect(a.warnings, label).toEqual(b.warnings);
      expect(diffSpecs(a.spec, b.spec).changes, label).toEqual([]);
      expect(diffSpecs(b.spec, a.spec).changes, label).toEqual([]);
      return a;
    };

    /** The `null` variant a union lists, in this version's spelling. */
    const nullVariant = openapi === '3.0.3' ? { enum: [null] } : { type: 'null' };
    /** A property pinned to one string, in this version's spelling. */
    const pinned = (value: string) =>
      openapi === '3.0.3' ? { type: 'string', enum: [value] } : { type: 'string', const: value };

    const components: Record<string, Doc> = {
      Owner: object({ name: str }),
      Shelter: object({ shelterId: str }),
      Nick: str,
      Tags: { type: 'array', items: str },
      Kind: { type: 'string', enum: ['cat', 'dog'] },
      Either: { oneOf: [str, int] },
      MaybeOwner: { oneOf: [ref('Owner'), nullVariant] },
      Cat: object({ kind: pinned('cat'), meow: str }, { required: ['kind'] }),
      Dog: object({ kind: pinned('dog'), bark: str }, { required: ['kind'] }),
    };
    /** The models the components alone build, in order. */
    const componentModels = ['Owner', 'Shelter', 'Either', 'MaybeOwner', 'Cat', 'Dog'];

    const getPet = (response: unknown = json(ref('Pet')), extra: Doc = {}) => ({
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: str }],
          responses: { '200': { description: 'OK', ...(response as Doc) } },
          ...extra,
        },
      },
    });
    /** A document whose `Pet` has `properties`, beside the shared components. */
    const petDoc = (properties: Doc, schemas: Record<string, unknown> = {}, paths: Doc = getPet()): Doc => ({
      openapi,
      info: { title: 'Repro', version: '1.0.0' },
      paths,
      components: { schemas: { ...components, ...schemas, Pet: object(properties) } },
    });
    /** `Pet.contact` written as `schema`, parsed: how the field is typed, and every model beyond the components'. */
    const contactOf = async (schema: unknown) => {
      const { spec, warnings } = await read(petDoc({ contact: schema }));
      const field = model(spec, 'Pet').fields.find((f) => f.name === 'contact')!;
      const minted = spec.models
        .filter((m) => !componentModels.includes(m.name) && m.name !== 'Pet')
        .map((m) => `${m.name} { ${fieldsOf(m).join(', ')} }`);
      return { spec, warnings, field, type: show(field.type), minted };
    };

    /** The issue's unions. */
    const contact = { anyOf: [ref('Owner'), str] };
    const nick = { anyOf: [ref('Nick'), int] };

    describe('the issue', () => {
      /** The issue's documents: `Owner`, `Nick` and `Pet`, and `GET /pets/{petId}` returning `Pet`. */
      const issueDoc = (wrap: (union: Doc) => Doc): Doc => ({
        openapi,
        info: { title: 'Repro', version: '1.0.0' },
        paths: getPet(),
        components: {
          schemas: {
            Owner: { type: 'object', properties: { name: { type: 'string' } } },
            Nick: { type: 'string' },
            Pet: { type: 'object', properties: { contact: wrap(contact), nick: wrap(nick) } },
          },
        },
      });
      const bare = issueDoc((union) => ({ allOf: [union] }));
      const described = issueDoc((union) => ({ allOf: [union, { description: 'Who to call.' }] }));
      /** What the issue's script prints. */
      const printed = ({ models }: ApiSpec): string => {
        const shown = (type: TypeRef): string =>
          type.kind === 'union'
            ? type.variants.map(shown).join(' | ')
            : ((type as { name?: string }).name ?? (type as { type: string }).type);
        return models
          .map(
            ({ fields, name }) =>
              `${name} { ${fields.map((field) => `${field.name}: ${shown(field.type)}`).join(', ')} }`,
          )
          .join(' ');
      };
      const expected = 'Owner { name: string } Pet { contact: Owner | string, nick: string | integer }';

      it('`described.json` prints what `bare.json` prints: the unions, no `PetContact`, no `PetNick`', async () => {
        const lone = await read(bare);
        const beside = await read(described);
        expect(printed(lone.spec)).toBe(expected);
        // The base printed `Owner { name: string } Pet { contact: PetContact, nick: PetNick } PetContact { name:
        // string } PetNick {  }`.
        expect(printed(beside.spec)).toBe(expected);
        expect(modelNames(beside.spec)).toEqual(['Owner', 'Pet']);
        expect(beside.warnings).toEqual([]);
        // The two differ by the text alone, which is the field's.
        expect(model(beside.spec, 'Pet').fields.map((f) => f.description)).toEqual(['Who to call.', 'Who to call.']);
        expect(model(beside.spec, 'Pet').fields.map((f) => f.type)).toEqual(
          model(lone.spec, 'Pet').fields.map((f) => f.type),
        );
      });

      it('so do `{ minLength: 1 }` and `{ not: { type: "null" } }` as the second member', async () => {
        for (const second of [{ minLength: 1 }, { not: { type: 'null' } }, { title: 'Contact' }, {}]) {
          const { spec, warnings } = await read(issueDoc((union) => ({ allOf: [union, second] })));
          expect(printed(spec), JSON.stringify(second)).toBe(expected);
          expect(warnings, JSON.stringify(second)).toEqual([]);
        }
      });

      it('`described.json` is `bare.json` with the description written beside the `allOf`', async () => {
        await expectSameReading(
          described,
          issueDoc((union) => ({ allOf: [union], description: 'Who to call.' })),
        );
      });

      it('`oagen diff` between `bare.json` and `described.json` reports nothing and exits 0, in either direction', async () => {
        const files = [await write(bare, 'bare.json'), await write(described, 'described.json')];
        vi.spyOn(console, 'log').mockImplementation(() => {});
        for (const [from, to] of [files, [...files].reverse()]) {
          const error = (await diffCommand({ old: from!, new: to! }).catch((e: unknown) => e)) as { exitCode: number };
          expect(error.exitCode).toBe(0);
        }
        const [lone, beside] = [await read(bare), await read(described)];
        // The base reported two `model-added` and a breaking `model-modified` of `Pet`.
        expect(diffSpecs(lone.spec, beside.spec).changes).toEqual([]);
        expect(diffSpecs(beside.spec, lone.spec).changes).toEqual([]);
      });
    });

    describe('every union the member can be', () => {
      const inline = (name: string) => object({ [name]: str });
      /** Each union with the type the field takes and the models its inline variants build. */
      const unions = (keyword: 'anyOf' | 'oneOf'): Array<[string, Doc, string, string[]]> => [
        [
          'a `$ref` to an object component beside a primitive',
          { [keyword]: [ref('Owner'), str] },
          '(Owner | string)',
          [],
        ],
        ['the primitive first', { [keyword]: [str, ref('Owner')] }, '(string | Owner)', []],
        ['a `$ref` to a primitive component', { [keyword]: [ref('Nick'), int] }, '(string | integer)', []],
        ['a `$ref` to an array component', { [keyword]: [ref('Tags'), str] }, '(string[] | string)', []],
        ['a `$ref` to an enum component', { [keyword]: [ref('Kind'), int] }, '(Kind | integer)', []],
        ['a `$ref` to a union component', { [keyword]: [ref('Either'), bool] }, '(Either | boolean)', []],
        [
          'a `$ref` to a nullable component',
          { [keyword]: [ref('MaybeOwner'), str] },
          '(nullable<MaybeOwner> | string)',
          [],
        ],
        ['two `$ref`s', { [keyword]: [ref('Owner'), ref('Shelter')] }, '(Owner | Shelter)', []],
        ['three `$ref`s', { [keyword]: [ref('Owner'), ref('Shelter'), ref('Cat')] }, '(Owner | Shelter | Cat)', []],
        [
          'a `$ref` beside a primitive and `null`',
          { [keyword]: [ref('Owner'), str, nullVariant] },
          'nullable<(Owner | string)>',
          [],
        ],
        [
          'an inline object beside a `$ref`',
          { [keyword]: [ref('Owner'), inline('phone')] },
          '(Owner | PetContact)',
          ['PetContact { phone?: string }'],
        ],
        [
          'two inline objects',
          { [keyword]: [inline('a'), inline('b')] },
          '(PetContact | PetContactWithB)',
          ['PetContact { a?: string }', 'PetContactWithB { b?: string }'],
        ],
        [
          'an inline object beside a primitive',
          { [keyword]: [inline('a'), str] },
          '(PetContact | string)',
          ['PetContact { a?: string }'],
        ],
        ['a union of one inline object', { [keyword]: [inline('a')] }, '(PetContact)', ['PetContact { a?: string }']],
        [
          'a variant that is itself an `allOf`',
          { [keyword]: [{ allOf: [ref('Owner'), inline('extra')] }, str] },
          '(PetContact | string)',
          ['PetContact { name?: string, extra?: string }'],
        ],
        [
          'a union of one around the union',
          { [keyword]: [{ [keyword]: [ref('Owner'), str] }] },
          '((Owner | string))',
          [],
        ],
        ['an `allOf` around the union', { allOf: [{ [keyword]: [ref('Owner'), str] }] }, '(Owner | string)', []],
        [
          'a wrapper no splice opens around the union',
          { additionalProperties: false, allOf: [{ [keyword]: [ref('Owner'), ref('Shelter')] }] },
          '(Owner | Shelter)',
          [],
        ],
        [
          '`type: object` beside the union',
          { type: 'object', [keyword]: [ref('Owner'), ref('Shelter')] },
          '(Owner | Shelter)',
          [],
        ],
        [
          '`properties` beside the union',
          { properties: { id: str }, [keyword]: [inline('a'), inline('b')] },
          '(PetContact | PetContactWithB)',
          ['PetContact { id?: string, a?: string }', 'PetContactWithB { id?: string, b?: string }'],
        ],
      ];

      it.each(['anyOf', 'oneOf'] as const)(
        'is that union beside `{ description }`, as the lone member is (%s)',
        async (keyword) => {
          for (const [label, union, type, minted] of unions(keyword)) {
            const beside = await contactOf({ allOf: [union, D] });
            expect(beside.type, label).toBe(type);
            expect(beside.minted, label).toEqual(minted);
            expect(beside.field.description, label).toBe('Who to call.');
            // The lone member, and the text written beside the `allOf`.
            expect((await contactOf({ allOf: [union] })).type, label).toBe(type);
            await expectSameReading(
              petDoc({ contact: { allOf: [union, D] } }),
              petDoc({ contact: { allOf: [union], ...D } }),
              label,
            );
          }
        },
      );

      it('reads what the base read for a `$ref` variant: every reported model is gone', async () => {
        // Each was `PetContact` on the base, the merge of the variants' object properties.
        const before: Array<[Doc, string]> = [
          [{ anyOf: [ref('Owner'), str] }, 'PetContact { name?: string }'],
          [{ anyOf: [ref('Nick'), int] }, 'PetContact {  }'],
          [{ anyOf: [ref('Tags'), str] }, 'PetContact {  }'],
          [{ anyOf: [ref('Owner'), ref('Shelter')] }, 'PetContact { name?: string, shelterId?: string }'],
        ];
        for (const [union] of before) {
          const { spec } = await read(petDoc({ contact: { allOf: [union, D] } }));
          expect(modelNames(spec)).toEqual([...componentModels, 'Pet']);
        }
      });

      it('a discriminated `oneOf` keeps its `discriminator`, written on the member or beside the `allOf`', async () => {
        const mapping = { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' };
        const union = { oneOf: [ref('Cat'), ref('Dog')] };
        const discriminator = { propertyName: 'kind', mapping };
        const onMember = await contactOf({ allOf: [{ ...union, discriminator }, D] });
        // The base flattened the variants: `PetContact { kind?, meow?, bark? }`, no `discriminator`.
        expect(onMember.type).toBe('(Cat | Dog) by kind');
        expect(onMember.minted).toEqual([]);
        expect(onMember.field.type).toMatchObject({
          discriminator: { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } },
        });
        await expectSameReading(
          petDoc({ contact: { allOf: [{ ...union, discriminator }, D] } }),
          petDoc({ contact: { allOf: [{ ...union, discriminator }], ...D } }),
        );
        await expectSameReading(
          petDoc({ contact: { allOf: [union, D], discriminator } }),
          petDoc({ contact: { allOf: [union], discriminator, ...D } }),
        );
        // With no `mapping`, the variants' own pins give it.
        const derived = await contactOf({ allOf: [{ ...union, discriminator: { propertyName: 'kind' } }, D] });
        expect(derived.type).toBe('(Cat | Dog) by kind');
      });

      it('pins the readings that were already the member: a nullable `$ref`, a union of one `$ref`, primitives, consts', async () => {
        const already: Array<[string, Doc, string, string[]]> = [
          ['a `$ref` beside `null`', { oneOf: [ref('Owner'), nullVariant] }, 'nullable<Owner>', []],
          ['a union of one `$ref` (#717)', { oneOf: [ref('Owner')] }, '(Owner)', []],
          ['a union of primitives', { anyOf: [str, int] }, '(string | integer)', []],
          ['a union of one primitive', { anyOf: [str] }, '(string)', []],
        ];
        for (const [label, union, type, minted] of already) {
          const beside = await contactOf({ allOf: [union, D] });
          expect(beside.type, label).toBe(type);
          expect(beside.minted, label).toEqual(minted);
          expect(readInlineAllOf([union as SchemaObject, D]), label).toBe('unwrapped');
          await expectSameReading(
            petDoc({ contact: { allOf: [union, D] } }),
            petDoc({ contact: { allOf: [union], ...D } }),
            label,
          );
        }
      });

      it('a nullable wrapper around an inline object is still the merged model, the model the wrapper alone is', async () => {
        // A nullable wrapper is no union: it is the variant it wraps, an inline object.
        const wrapper = { oneOf: [object({ a: str }), nullVariant] };
        expect(readInlineAllOf([wrapper as SchemaObject, D])).toBe('merged');
        const beside = await contactOf({ allOf: [wrapper, D] });
        expect(beside.type).toBe('nullable<PetContact>');
        expect(beside.minted).toEqual(['PetContact { a?: string }']);
        await expectSameReading(
          petDoc({ contact: { allOf: [wrapper, D] } }),
          petDoc({ contact: { allOf: [wrapper], ...D } }),
        );
      });
    });

    describe('every annotating member', () => {
      /** Each spelling of the members beside the union, with the same keywords written beside the `allOf` instead. */
      const spellings = (union: Doc): Array<[string, Doc, Doc]> => [
        ['`{ description }`', { allOf: [union, D] }, { allOf: [union], ...D }],
        ['`{ title }`', { allOf: [union, { title: 'Contact' }] }, { allOf: [union], title: 'Contact' }],
        ['`{ minLength: 1 }`', { allOf: [union, { minLength: 1 }] }, { allOf: [union], minLength: 1 }],
        ['`{ deprecated: true }`', { allOf: [union, { deprecated: true }] }, { allOf: [union], deprecated: true }],
        ['`{ readOnly: true }`', { allOf: [union, { readOnly: true }] }, { allOf: [union], readOnly: true }],
        ['`{ example }`', { allOf: [union, { example: 'x' }] }, { allOf: [union], example: 'x' }],
        ['an `x-*` key', { allOf: [union, { 'x-internal': true }] }, { allOf: [union], 'x-internal': true }],
        [
          '`{ not: { type: "null" } }`',
          { allOf: [union, { not: { type: 'null' } }] },
          { allOf: [union], not: { type: 'null' } },
        ],
        ['`{}`', { allOf: [union, {}] }, { allOf: [union] }],
        ['the member first', { allOf: [D, union] }, { allOf: [union], ...D }],
        ['two members', { allOf: [union, D, { minLength: 1 }] }, { allOf: [union], ...D, minLength: 1 }],
        [
          'three members',
          { allOf: [union, D, { minLength: 1 }, { deprecated: true }] },
          { allOf: [union], ...D, minLength: 1, deprecated: true },
        ],
        ['the union in the middle', { allOf: [D, union, { minLength: 1 }] }, { allOf: [union], ...D, minLength: 1 }],
        ['the union last', { allOf: [D, { minLength: 1 }, union] }, { allOf: [union], ...D, minLength: 1 }],
        // The first member's text wins, as a wrapper's own does over a member's.
        ['two descriptions', { allOf: [union, D, { description: 'Second.' }] }, { allOf: [union], ...D }],
        [
          'a description beside the `allOf` and one in a member',
          { allOf: [union, { description: 'Member.' }], ...D },
          { allOf: [union], ...D },
        ],
        ['a member that is an `allOf` of one annotation', { allOf: [union, { allOf: [D] }] }, { allOf: [union], ...D }],
      ];

      it('leaves the union the union, and writes on the field what the same keywords beside the `allOf` write', async () => {
        for (const union of [contact, nick, { oneOf: [object({ a: str }), str] }]) {
          const lone = (await contactOf({ allOf: [union] })).field.type;
          for (const [label, member, wrapper] of spellings(union)) {
            const beside = await contactOf(member);
            expect(beside.field.type.kind, label).toBe('union');
            // The limits a member writes are the field's, and the union's (`constraints`), as the wrapper's are.
            expect({ ...beside.field.type, constraints: undefined }, label).toEqual({
              ...lone,
              constraints: undefined,
            });
            await expectSameReading(petDoc({ contact: member }), petDoc({ contact: wrapper }), label);
          }
        }
      });

      it.runIf(openapi === '3.1.0')('reads `true` as a member that says nothing', async () => {
        for (const union of [contact, nick]) {
          await expectSameReading(
            petDoc({ contact: { allOf: [union, true] } }),
            petDoc({ contact: { allOf: [union] } }),
          );
          await expectSameReading(
            petDoc({ contact: { allOf: [true, union, D] } }),
            petDoc({ contact: { allOf: [union], ...D } }),
          );
        }
      });

      it('`{ not: { type: "null" } }` vetoes the `null` the union lists, as it does written beside the `allOf` (#726)', async () => {
        const nullable = { anyOf: [ref('Owner'), str, nullVariant] };
        expect((await contactOf({ allOf: [nullable] })).type).toBe('nullable<(Owner | string)>');
        expect((await contactOf({ allOf: [nullable, D] })).type).toBe('nullable<(Owner | string)>');
        // The base merged the variants and vetoed the `null` of the model: `PetContact { name? }`.
        expect((await contactOf({ allOf: [nullable, { not: { type: 'null' } }] })).type).toBe('(Owner | string)');
        expect((await contactOf({ allOf: [nullable], not: { type: 'null' } })).type).toBe('(Owner | string)');
        expect((await contactOf({ allOf: [{ not: { type: 'null' } }, nullable, D] })).type).toBe('(Owner | string)');
        // A nullable `$ref` wrapper, which was the member already.
        const wrapper = { oneOf: [ref('Owner'), nullVariant] };
        expect((await contactOf({ allOf: [wrapper, D] })).type).toBe('nullable<Owner>');
        expect((await contactOf({ allOf: [wrapper, { not: { type: 'null' } }] })).type).toBe('Owner');
      });
    });

    describe('every site', () => {
      const post = (extra: Doc, response: unknown = json(ref('Pet'))): Doc => ({
        '/pets/{petId}': {
          post: {
            operationId: 'updatePet',
            parameters: [
              { name: 'petId', in: 'path', required: true, schema: str },
              ...((extra.parameters as unknown[]) ?? []),
            ],
            ...(extra.requestBody ? { requestBody: extra.requestBody } : {}),
            responses: {
              '200': { description: 'OK', ...(response as Doc), ...(extra.headers ? { headers: extra.headers } : {}) },
              ...(extra.responses as Doc | undefined),
            },
          },
        },
      });
      const id = { id: str };
      /** Each site the `allOf` can be written at, with where its type lands in the IR. */
      const sites: Array<[string, (schema: unknown) => Doc, (spec: ApiSpec) => TypeRef | undefined]> = [
        ['a field', (s) => petDoc({ contact: s }), (spec) => model(spec, 'Pet').fields[0]?.type],
        [
          'array items',
          (s) => petDoc({ contacts: { type: 'array', items: s } }),
          (spec) => model(spec, 'Pet').fields[0]?.type,
        ],
        [
          'map values',
          (s) => petDoc({ contacts: { type: 'object', additionalProperties: s } }),
          (spec) => model(spec, 'Pet').fields[0]?.type,
        ],
        [
          'a field of an inline object',
          (s) => petDoc({ outer: object({ contact: s }) }),
          (spec) => model(spec, 'PetOuter').fields[0]?.type,
        ],
        [
          'a variant of a union',
          (s) => petDoc({ contact: { oneOf: [s, bool] } }),
          (spec) => model(spec, 'Pet').fields[0]?.type,
        ],
        [
          'the member of a lone `allOf` around it',
          (s) => petDoc({ contact: { allOf: [s] } }),
          (spec) => model(spec, 'Pet').fields[0]?.type,
        ],
        [
          'a request body',
          (s) => petDoc(id, {}, post({ requestBody: json(s) })),
          (spec) => operation(spec, 'updatePet').requestBody,
        ],
        ['a response body', (s) => petDoc(id, {}, post({}, json(s))), (spec) => operation(spec, 'updatePet').response],
        [
          'an error body',
          (s) => petDoc(id, {}, post({ responses: { '404': { description: 'No', ...json(s) } } })),
          (spec) => operation(spec, 'updatePet').errors[0]?.type,
        ],
        [
          'a query parameter',
          (s) => petDoc(id, {}, post({ parameters: [{ name: 'contact', in: 'query', schema: s }] })),
          (spec) => operation(spec, 'updatePet').queryParams[0]?.type,
        ],
        [
          'a response header',
          (s) => petDoc(id, {}, post({ headers: { 'X-Contact': { schema: s } } })),
          (spec) => collectResponseHeaders(operation(spec, 'updatePet'))[0]?.type,
        ],
        [
          'a field of a component the body names',
          (s) => petDoc({ holder: ref('Holder') }, { Holder: object({ contact: s }) }),
          (spec) => model(spec, 'Holder').fields[0]?.type,
        ],
      ];
      const wrapped: Record<string, (inner: string) => string> = {
        'array items': (inner) => `${inner}[]`,
        'map values': (inner) => `map<${inner}>`,
        'a variant of a union': (inner) => `(${inner} | boolean)`,
      };

      it('reads the union, and mints no model, wherever the `allOf` is written', async () => {
        for (const [union, type] of [
          [contact, '(Owner | string)'],
          [nick, '(string | integer)'],
          [{ oneOf: [ref('Owner'), ref('Shelter')] }, '(Owner | Shelter)'],
        ] as Array<[Doc, string]>) {
          for (const [label, at, typed] of sites) {
            const { spec, warnings } = await read(at({ allOf: [union, D] }));
            expect(show(typed(spec)), label).toBe((wrapped[label] ?? ((inner) => inner))(type));
            // The base minted the merged model at every one of them: `PetContact`, `UpdatePetRequest`, …
            expect(
              modelNames(spec).filter((name) => ![...componentModels, 'Pet', 'PetOuter', 'Holder'].includes(name)),
              label,
            ).toEqual([]);
            expect(warnings, label).toEqual([]);
            await expectSameReading(at({ allOf: [union, D] }), at({ allOf: [union], ...D }), label);
            await expectSameReading(
              at({ allOf: [union, D, { minLength: 1 }] }),
              at({ allOf: [union], ...D, minLength: 1 }),
              label,
            );
          }
        }
      });

      it('builds a model per inline variant at every site, named as the lone member’s are', async () => {
        const union = { oneOf: [object({ a: str }), str] };
        for (const [label, at] of sites) {
          const beside = await read(at({ allOf: [union, D] }));
          const lone = await read(at({ allOf: [union] }));
          expect(modelNames(beside.spec), label).toEqual(modelNames(lone.spec));
          await expectSameReading(at({ allOf: [union, D] }), at({ allOf: [union], ...D }), label);
        }
      });

      it.runIf(openapi === '3.1.0')('reads a webhook payload the same way', async () => {
        const hooked = (schema: unknown): Doc => ({
          ...petDoc({ id: str }),
          webhooks: {
            petChanged: {
              post: {
                operationId: 'petChanged',
                requestBody: json(schema),
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        });
        const { spec } = await read(hooked({ allOf: [contact, D] }));
        expect(spec.webhooks?.flatMap(collectWebhookTypeRefs).map(show)).toEqual(['(Owner | string)']);
        expect(modelNames(spec)).toEqual([...componentModels, 'Pet']);
        await expectSameReading(hooked({ allOf: [contact, D] }), hooked({ allOf: [contact], ...D }));
      });

      it('a list response that is a union of pages is the union, as the lone member is, not a list unwrapped on a merge', async () => {
        const page = (extra: Doc = {}) =>
          object(
            { data: { type: 'array', items: ref('Owner') }, has_more: bool, ...extra },
            { required: ['data', 'has_more'] },
          );
        const listed = (schema: unknown): Doc => ({
          openapi,
          info: { title: 'Repro', version: '1.0.0' },
          paths: {
            '/owners': {
              get: {
                operationId: 'listOwners',
                parameters: [{ name: 'after', in: 'query', schema: str }],
                responses: { '200': { description: 'OK', ...json(schema) } },
              },
            },
          },
          components: { schemas: { ...components, PageA: page(), PageB: page({ total: int }) } },
        });
        const union = { oneOf: [ref('PageA'), ref('PageB')] };
        for (const body of [{ allOf: [union] }, { allOf: [union], description: 'A page.' }]) {
          expect(show(operation((await read(listed(body))).spec, 'listOwners').response)).toBe('(PageA | PageB)');
        }
        // The base merged the two pages into one envelope and unwrapped it: `Owner[]`.
        const { spec } = await read(listed({ allOf: [union, { description: 'A page.' }] }));
        expect(show(operation(spec, 'listOwners').response)).toBe('(PageA | PageB)');
        await expectSameReading(
          listed({ allOf: [union, { description: 'A page.' }] }),
          listed({ allOf: [union], description: 'A page.' }),
        );
        // Beside a member that types the body the union is still merged, and the envelope found.
        const merged = await read(
          listed({
            allOf: [object({ data: { type: 'array', items: ref('Owner') } }), union, { description: 'A page.' }],
          }),
        );
        expect(show(operation(merged.spec, 'listOwners').response)).toBe('Owner[]');
      });
    });

    describe('a `required` list', () => {
      const named = { required: ['name'] };

      it('beside a union that names an object still adds to it: the merged model, as beside the lone member', async () => {
        const merged = ['PetContact { name: string }'];
        for (const [label, schema] of [
          ['beside the lone member', { allOf: [contact], ...named }],
          ['beside the `allOf`, with a description member', { allOf: [contact, D], ...named }],
          ['in a member of its own', { allOf: [contact, named] }],
          ['in a member of its own, with a description member', { allOf: [contact, named, D] }],
        ] as Array<[string, Doc]>) {
          const beside = await contactOf(schema);
          expect(beside.type, label).toBe('PetContact');
          expect(beside.minted, label).toEqual(merged);
        }
        // An inline object variant is an object the list adds to as well.
        const inline = { oneOf: [object({ a: str }), object({ b: str })] };
        for (const schema of [
          { allOf: [inline], required: ['a'] },
          { allOf: [inline, D], required: ['a'] },
        ]) {
          const beside = await contactOf(schema);
          expect(beside.type).toBe('PetContact');
          expect(beside.minted).toEqual(['PetContact { a: string, b?: string }']);
        }
      });

      it('beside a union that names no object constrains nothing, and the union stands', async () => {
        // `Nick` is a string, `Tags` an array, `Kind` an enum, `Either` a union: none declares a property.
        for (const [union, type] of [
          [nick, '(string | integer)'],
          [{ anyOf: [ref('Tags'), str] }, '(string[] | string)'],
          [{ anyOf: [ref('Kind'), int] }, '(Kind | integer)'],
          [{ anyOf: [ref('Either'), bool] }, '(Either | boolean)'],
        ] as Array<[Doc, string]>) {
          for (const schema of [
            { allOf: [union], ...named },
            { allOf: [union, D], ...named },
            { allOf: [union, named] },
            { allOf: [union, named, D] },
          ]) {
            const beside = await contactOf(schema);
            // The base built `PetContact {  }` for each: the `$ref` variant counted, whatever it named.
            expect(beside.type, JSON.stringify(schema)).toBe(type);
            expect(beside.minted, JSON.stringify(schema)).toEqual([]);
          }
        }
      });

      it('the union member writes itself is the member’s own, read with it', async () => {
        const own = { ...contact, required: ['name'] };
        // The base merged the member for the list it writes itself, where the lone member was the union.
        expect((await contactOf({ allOf: [own] })).type).toBe('(Owner | string)');
        expect((await contactOf({ allOf: [own, D] })).type).toBe('(Owner | string)');
        await expectSameReading(petDoc({ contact: { allOf: [own, D] } }), petDoc({ contact: { allOf: [own], ...D } }));
      });
    });

    describe('what does not change', () => {
      it('a union member beside another member that types the schema is merged (#398, #717)', async () => {
        const merged: Array<[string, Doc, string[]]> = [
          [
            'beside a `$ref`',
            { allOf: [contact, ref('Shelter')] },
            ['PetContact { name?: string, shelterId?: string }'],
          ],
          [
            'beside an inline object',
            { allOf: [contact, object({ extra: str })] },
            ['PetContact { name?: string, extra?: string }'],
          ],
          [
            'beside an inline object and a description',
            { allOf: [contact, object({ extra: str }), D] },
            ['PetContact { name?: string, extra?: string }'],
          ],
          ['beside `{ type: object }`', { allOf: [contact, { type: 'object' }] }, ['PetContact { name?: string }']],
          ['beside a primitive', { allOf: [contact, str] }, ['PetContact { name?: string }']],
          [
            'beside a second union',
            { allOf: [contact, { oneOf: [ref('Shelter'), int] }] },
            ['PetContact { name?: string, shelterId?: string }'],
          ],
          [
            'a union of one `$ref` beside a `$ref` (#717)',
            { allOf: [{ oneOf: [ref('Owner')] }, ref('Shelter')] },
            ['PetContact { name?: string, shelterId?: string }'],
          ],
          [
            'beside a union written on the wrapper',
            { allOf: [contact, D], oneOf: [ref('Cat'), ref('Dog')] },
            ['PetContact { name?: string, kind?: PetContactKind, meow?: string, bark?: string }'],
          ],
          [
            'beside `properties` written on the wrapper',
            { allOf: [contact, D], properties: { extra: str } },
            ['PetContact { extra?: string, name?: string }'],
          ],
        ];
        for (const [label, schema, minted] of merged) {
          const beside = await contactOf(schema);
          expect(beside.type, label).toBe('PetContact');
          expect(beside.minted, label).toEqual(minted);
        }
      });

      it('an inline object beside annotating members is the merged model, and a lone member the member', async () => {
        const inline = object({ name: str });
        expect(readInlineAllOf([inline as SchemaObject, D])).toBe('merged');
        expect((await contactOf({ allOf: [inline, D] })).minted).toEqual(['PetContact { name?: string }']);
        expect(readInlineAllOf([contact as SchemaObject])).toBe('unwrapped');
        expect(readInlineAllOf([inline as SchemaObject])).toBe('unwrapped');
        await expectSameReading(
          petDoc({ contact: { allOf: [inline, D] } }),
          petDoc({ contact: { allOf: [inline], ...D } }),
        );
      });

      it('a component written so is the model it was, in each spelling', async () => {
        // A component's `allOf` composes a model (`extractAllOfModel`), the union read into it.
        const spelled = [{ allOf: [contact] }, { allOf: [contact], ...D }, { allOf: [contact, D] }];
        const lines: string[] = [];
        for (const Contact of spelled) {
          const { spec } = await read(petDoc({ contact: ref('Contact') }, { Contact }));
          lines.push(`${fieldsOf(model(spec, 'Contact')).join(', ')} | ${fieldsOf(model(spec, 'Pet')).join(', ')}`);
          expect(model(spec, 'Contact').variants).toBeUndefined();
        }
        expect(lines).toEqual(Array(3).fill('name?: string | contact?: Contact'));
        await expectSameReading(
          petDoc({ contact: ref('Contact') }, { Contact: spelled[2] }),
          petDoc({ contact: ref('Contact') }, { Contact: spelled[1] }),
        );
      });
    });

    describe('the one decision', () => {
      const owner = ref('Owner') as SchemaObject;
      const shelter = ref('Shelter') as SchemaObject;
      const schemas = components as Record<string, SchemaObject>;
      const reading = (members: SchemaObject[], wrapper: SchemaObject = {}) =>
        readInlineAllOf(members, { ...wrapper, allOf: members }, schemas);
      const text: SchemaObject = { description: 'd' };

      it('`readInlineAllOf` reads one union member beside annotating members as the member', () => {
        const unwrapped: Array<[string, SchemaObject[], SchemaObject?]> = [
          ['two `$ref` variants', [{ oneOf: [owner, shelter] }, text]],
          ['a `$ref` and a primitive', [{ anyOf: [owner, str] }, text]],
          ['a `$ref` to a primitive component', [{ anyOf: [ref('Nick'), int] }, text]],
          ['inline object variants', [{ oneOf: [object({ a: str }), object({ b: str })] }, text]],
          ['a union of one inline object', [{ oneOf: [object({ a: str })] }, text]],
          ['beside a limit', [{ oneOf: [owner, shelter] }, { minLength: 1 }]],
          ['beside `not null`', [{ oneOf: [owner, shelter] }, { not: { type: 'null' } }]],
          ['beside `{}`', [{ oneOf: [owner, shelter] }, {}]],
          ['the member last of three', [text, { minLength: 1 }, { oneOf: [owner, shelter] }]],
          ['a nullable wrapper around a union', [{ oneOf: [{ anyOf: [owner, str] }, { type: 'null' }] }, text]],
          [
            'an `allOf` around the union',
            [{ additionalProperties: false, allOf: [{ oneOf: [owner, shelter] }] }, text],
          ],
          ['`properties` beside the union', [{ properties: { id: str }, oneOf: [owner, shelter] }, text]],
          ['a wrapped annotation beside it', [{ oneOf: [owner, shelter] }, { allOf: [text] }]],
          [
            'a `required` list beside a union that names no object',
            [{ anyOf: [ref('Nick'), int] }, text],
            { required: ['x'] },
          ],
          [
            'a `required` list beside a lone union that names no object',
            [{ anyOf: [ref('Nick'), int] }],
            { required: ['x'] },
          ],
          ['the list the union member writes itself', [{ oneOf: [owner, shelter], required: ['name'] }, text]],
        ] as Array<[string, SchemaObject[], SchemaObject?]>;
        for (const [label, members, wrapper] of unwrapped) {
          expect(reading(members, wrapper), label).toBe('unwrapped');
          expect(classifyInlineSchema({ ...wrapper, allOf: members }), label).toBe('allOf');
          // One member types the `allOf`, and it carries the union.
          const typing = allOfTypingMember(splicedAllOfMembers(members).members);
          expect(typing && carriesUnion(typing), label).toBe(true);
        }
        const merged: Array<[string, SchemaObject[], SchemaObject?]> = [
          ['beside a `$ref` member', [{ oneOf: [owner, shelter] }, owner]],
          ['beside an inline object', [{ oneOf: [owner, shelter] }, object({ extra: str }), text]],
          ['beside `{ type: object }`', [{ oneOf: [owner, shelter] }, { type: 'object' }]],
          ['beside a primitive', [{ oneOf: [owner, shelter] }, str]],
          ['beside a second union', [{ oneOf: [owner, shelter] }, { anyOf: [ref('Cat'), ref('Dog')] }]],
          ['a `required` list beside the `allOf`', [{ oneOf: [owner, shelter] }, text], { required: ['name'] }],
          ['a `required` list in a member', [{ oneOf: [owner, shelter] }, { required: ['name'] }]],
          ['a `required` list beside the lone member', [{ oneOf: [owner, shelter] }], { required: ['name'] }],
          [
            'a `required` list beside inline variants',
            [{ oneOf: [object({ a: str }), str] }, text],
            { required: ['a'] },
          ],
          ['an inline object beside an annotation', [object({ a: str }), text]],
          ['a nullable wrapper around an inline object', [{ oneOf: [object({ a: str }), { type: 'null' }] }, text]],
        ] as Array<[string, SchemaObject[], SchemaObject?]>;
        for (const [label, members, wrapper] of merged) expect(reading(members, wrapper), label).toBe('merged');
      });

      it('`carriesUnion` says whether a member carries a union the type builder types as one', () => {
        const union: SchemaObject = { oneOf: [owner, shelter] };
        expect(carriesUnion(union)).toBe(true);
        expect(carriesUnion({ anyOf: [owner] })).toBe(true);
        expect(carriesUnion({ anyOf: [str, int] })).toBe(true);
        expect(carriesUnion({ properties: { id: str }, oneOf: [owner, shelter] })).toBe(true);
        expect(carriesUnion({ allOf: [union] })).toBe(true);
        expect(carriesUnion({ additionalProperties: false, allOf: [{ allOf: [union] }] })).toBe(true);
        // A nullable wrapper is the variant it wraps.
        expect(carriesUnion({ oneOf: [owner, { type: 'null' }] })).toBe(false);
        expect(carriesUnion({ oneOf: [object({ a: str }), { type: 'null' }] })).toBe(false);
        expect(carriesUnion({ oneOf: [owner], nullable: true })).toBe(false);
        expect(carriesUnion({ oneOf: [union, { type: 'null' }] })).toBe(true);
        // No union, a `$ref`, and a union of bare limits, which types nothing.
        expect(carriesUnion(object({ a: str }))).toBe(false);
        expect(carriesUnion(owner)).toBe(false);
        expect(carriesUnion({ $ref: '#/components/schemas/Owner', oneOf: [owner, shelter] })).toBe(false);
        expect(carriesUnion({ properties: { a: str }, anyOf: [{ required: ['a'] }, { maxProperties: 1 }] })).toBe(
          false,
        );
        // A member that holds itself ends the walk.
        const loop: SchemaObject = { allOf: [] };
        loop.allOf!.push(loop);
        expect(carriesUnion(loop)).toBe(false);
        const looped: SchemaObject = { allOf: [union] };
        looped.allOf!.unshift(looped);
        expect(carriesUnion(looped)).toBe(true);
      });

      it('`declaresInlineProperties` and `referencesThroughUnion` answer as they did', () => {
        expect(declaresInlineProperties({ oneOf: [owner, shelter] })).toBe(true);
        expect(declaresInlineProperties({ oneOf: [owner] })).toBe(false);
        expect(referencesThroughUnion({ oneOf: [owner, shelter] })).toBe(true);
        expect(referencesThroughUnion({ anyOf: [str, int] })).toBe(false);
      });

      it('the type builder types the member the readers extract', () => {
        const schema: SchemaObject = { allOf: [{ anyOf: [owner, str] }, text] };
        expect(schemaToTypeRef(schema, 'contact', 'Pet')).toEqual({
          kind: 'union',
          compositionKind: 'anyOf',
          variants: [
            { kind: 'model', name: 'Owner' },
            { kind: 'primitive', type: 'string' },
          ],
        });
      });

      it('one union object written in two fields, and one annotation in two `allOf`s, read as copies do', async () => {
        const document = petDoc({ contact: { allOf: [contact, D] }, backup: { allOf: [contact, D] } });
        const copies = await parseSpec(await write(document));
        const shared = await parseSpec(await write(document), {
          transformSpec: (spec) => {
            const properties = (spec.components as { schemas: Record<string, { properties: Record<string, Doc> }> })
              .schemas.Pet!.properties;
            const first = properties.contact!.allOf as unknown[];
            (properties.backup!.allOf as unknown[]).splice(0, 2, first[0], first[1]);
            return spec;
          },
        });
        expect(fieldsOf(model(shared, 'Pet'))).toEqual(['contact?: (Owner | string)', 'backup?: (Owner | string)']);
        expect(shared.models).toEqual(copies.models);
      });
    });

    describe('a union member the type builder cannot read as written', () => {
      // The merge reads the object properties of a union's variants and nothing else of them; the type
      // builder reads every variant and every keyword of each. So a member one of whose keywords is
      // written as another kind of value keeps the reading it had, and each of these documents parses
      // as it did: the merged model, the unreadable variant unread.
      const kept = ['PetContact { name?: string }'];

      it('keeps the merge for a keyword written as another kind of value, at any depth', async () => {
        const unreadable: Array<[string, Doc]> = [
          ['an `enum` that is no list', { anyOf: [ref('Owner'), { type: 'string', enum: 'cat' }] }],
          [
            'an `enum` that is no list, under the items of a variant',
            { anyOf: [ref('Owner'), { type: 'array', items: { type: 'string', enum: 'cat' } }] },
          ],
          ['an `allOf` that is no list, beside a `$ref` variant', { anyOf: [{ ...ref('Owner'), allOf: {} }, str] }],
          [
            '`properties` that are no object, on a variant',
            { anyOf: [ref('Owner'), { type: 'string', properties: [] }] },
          ],
          [
            'a `mapping` entry that is no string',
            { oneOf: [ref('Owner'), str], discriminator: { propertyName: 'kind', mapping: { cat: 1 } } },
          ],
        ];
        for (const [label, union] of unreadable) {
          expect(isReadableSchema(union), label).toBe(false);
          expect(readInlineAllOf([union as SchemaObject, D]), label).toBe('merged');
          const beside = await contactOf({ allOf: [union, D] });
          expect(beside.type, label).toBe('PetContact');
          expect(beside.minted, label).toEqual(kept);
        }
        // A `required` that is no list on an inline variant, which the merge never read.
        const inline = { oneOf: [object({ a: str }, { required: true }), str] };
        expect(readInlineAllOf([inline as SchemaObject, D])).toBe('merged');
        expect((await contactOf({ allOf: [inline, D] })).minted).toEqual(['PetContact { a?: string }']);
      });

      it('keeps the merge a `required` list made of such a member, alone or beside an annotation', async () => {
        const union = { anyOf: [ref('Nick'), { type: 'string', enum: 'cat' }] } as unknown as SchemaObject;
        expect(readInlineAllOf([union], { allOf: [union], required: ['name'] })).toBe('merged');
        expect(readInlineAllOf([union, D], { allOf: [union, D], required: ['name'] })).toBe('merged');
        // Readable, the same union names no object, and the list constrains nothing.
        const readable = nick as SchemaObject;
        expect(readInlineAllOf([readable], { allOf: [readable], required: ['name'] })).toBe('unwrapped');
        for (const schema of [
          { allOf: [union], required: ['name'] },
          { allOf: [union, D], required: ['name'] },
        ]) {
          const beside = await contactOf(schema);
          expect(beside.type).toBe('PetContact');
          expect(beside.minted).toEqual(['PetContact {  }']);
        }
      });

      it('reads a variant that is no Schema Object where it stands, as the lone member does (#728)', async () => {
        // A JSON Schema boolean, or anything else a document holds where a schema goes, writes no keyword
        // and is `unknown`: the union is readable, and is the union.
        const variants: Array<[string, Doc, string]> = [
          ['`true` as a variant', { anyOf: [ref('Owner'), true] }, '(Owner | unknown)'],
          ['`false` as a variant', { anyOf: [ref('Owner'), false] }, '(Owner | unknown)'],
          [
            '`items: true` under a variant',
            { anyOf: [ref('Owner'), { type: 'array', items: true }] },
            '(Owner | unknown[])',
          ],
          [
            '`true` under a nested union',
            { anyOf: [ref('Owner'), { oneOf: [str, true] }] },
            '(Owner | (string | unknown))',
          ],
          ['a property `true` of an inline variant', { oneOf: [object({ a: true }), str] }, '(PetContact | string)'],
          ['a number as a variant', { anyOf: [ref('Owner'), 1] }, '(Owner | unknown)'],
          ['a list as a variant', { anyOf: [ref('Owner'), []] }, '(Owner | unknown)'],
        ];
        for (const [label, union, type] of variants) {
          expect(isReadableSchema(union), label).toBe(true);
          expect(readInlineAllOf([union as SchemaObject, D]), label).toBe('unwrapped');
          // The base merged each: `PetContact { name? }`, the variant unread.
          expect((await contactOf({ allOf: [union, D] })).type, label).toBe(type);
          await expectSameReading(
            petDoc({ contact: { allOf: [union, D] } }),
            petDoc({ contact: { allOf: [union], ...D } }),
            label,
          );
        }
        // A boolean beside the union is a member that says nothing.
        await expectSameReading(
          petDoc({ contact: { allOf: [contact, true] } }),
          petDoc({ contact: { allOf: [contact] } }),
        );
      });
    });
  },
);

describe('#732 `isReadableSchema`', () => {
  const owner = ref('Owner');

  it('is true of a schema whose keywords hold what the readers ask of them, at every depth', () => {
    for (const schema of [
      {},
      str,
      owner,
      { anyOf: [owner, str] },
      { allOf: [{ oneOf: [owner, { type: 'array', items: { anyOf: [str, int] } }] }, { description: 'd' }] },
      object({ a: object({ b: { type: 'string', enum: ['x'] } }) }, { required: ['a'] }),
      { type: 'object', additionalProperties: false },
      { type: 'object', additionalProperties: str, patternProperties: { '^x-': str } },
      { type: 'string', not: true },
      { type: 'string', not: { type: 'null' } },
      { oneOf: [owner, str], discriminator: { propertyName: 'kind' } },
      { oneOf: [owner, str], discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Owner' } } },
      // A value that is no Schema Object where a schema goes is read as `{}` is (#728).
      true,
      false,
      1,
      'x',
      [],
      { anyOf: [owner, true] },
      { allOf: [1] },
      { properties: { a: true } },
      { type: 'array', items: true },
      { type: 'object', additionalProperties: 1 },
      { not: [] },
    ]) {
      expect(isReadableSchema(schema), JSON.stringify(schema)).toBe(true);
    }
    // A schema that holds itself is read once.
    const loop: SchemaObject = { anyOf: [] };
    loop.anyOf!.push(loop, str as SchemaObject);
    expect(isReadableSchema(loop)).toBe(true);
  });

  it('is false of a keyword written as another kind of value, and of `null` where a schema goes, wherever it is written', () => {
    for (const schema of [
      null,
      undefined,
      { anyOf: [owner, null] },
      { anyOf: {} },
      { oneOf: 'x' },
      { allOf: true },
      { allOf: [{ anyOf: [owner, { oneOf: [str, null] }] }] },
      { properties: null },
      { properties: [] },
      { properties: 'x' },
      { properties: { a: null } },
      { patternProperties: 1 },
      { type: 'array', items: null },
      { type: 'array', items: { enum: 1 } },
      { type: 'object', additionalProperties: { required: 'a' } },
      { not: { anyOf: 1 } },
      { type: 'string', enum: 'cat' },
      { type: 'object', required: true },
      { oneOf: [owner, str], discriminator: 'kind' },
      { oneOf: [owner, str], discriminator: { propertyName: 'kind', mapping: { cat: 1 } } },
      { oneOf: [owner, str], discriminator: { propertyName: 'kind', mapping: ['Owner'] } },
    ]) {
      expect(isReadableSchema(schema), JSON.stringify(schema)).toBe(false);
    }
    // One keyword that is not, anywhere under a schema that holds itself.
    const loop: SchemaObject = { anyOf: [] };
    loop.anyOf!.push(loop, { type: 'string', enum: 'cat' } as unknown as SchemaObject);
    expect(isReadableSchema(loop)).toBe(false);
  });
});
