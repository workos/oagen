import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { axisDiscriminatorOf, isDecidedDiscriminator, wrapperDiscriminatorOf } from '../../src/parser/schemas.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import type { ApiSpec, Model, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #718: a component that writes a `oneOf` beside an `anyOf` is
 * composed of the two (#680), and a `discriminator` written beside them
 * went to the first union that types the schema, the `oneOf`, without its
 * `mapping` being read. A `mapping` makes the union it is handed to a
 * dispatcher whatever it names, so a `mapping` naming the `anyOf`'s
 * variants made the `oneOf` the dispatcher: its variants' properties were
 * read as dispatched, on no model, while the component dispatched to the
 * `anyOf`'s variants. A `discriminator` says which union a composed schema
 * dispatches by: the one whose variants its `mapping` names — wherever the
 * keyword is written among the unions the schema composes — and every
 * other union is flattened.
 */

type Doc = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const at = (name: string) => `#/components/schemas/${name}`;
const str = { type: 'string' };
const object = (properties: Doc, required: string[] = []): Doc => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
});
const json = (schema: unknown) => ({ 'application/json': { schema } });
const okBody = (schema: unknown) => ({ description: 'ok', content: json(schema) });

const show = (type: TypeRef | undefined): string => {
  if (!type) return String(type);
  switch (type.kind) {
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
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

describe.each(['3.1.0', '3.0.3'])('#718 a discriminator mapping naming the anyOf’s variants (OAS %s)', (openapi) => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let written = 0;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-718-'));
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
  const fieldsOf = (m: Model) => m.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${show(f.type)}`);
  const basesOf = (m: Model) => m.bases?.map(show);
  /** A model as one line: its fields, then what it dispatches by. */
  const reads = (spec: ApiSpec, name: string): string => {
    const { discriminator } = model(spec, name);
    const fields = `{ ${fieldsOf(model(spec, name)).join(', ')} }`;
    if (!discriminator) return fields;
    const mapping = Object.entries(discriminator.mapping).map(([value, target]) => `${value}: ${target}`);
    return `${fields} by ${discriminator.property} { ${mapping.join(', ')} }`;
  };

  /** A property pinned to one string, in this version's spelling. */
  const pinned = (value: string) =>
    openapi === '3.0.3' ? { type: 'string', enum: [value] } : { type: 'string', const: value };
  const nullVariant = openapi === '3.0.3' ? { enum: [null] } : { type: 'null' };

  const components: Record<string, Doc> = {
    // The issue's components, each pin spelled as the issue spells it in both versions.
    Cat: object({ kind: { type: 'string', enum: ['cat'] }, meow: str }, ['kind']),
    Dog: object({ kind: { type: 'string', enum: ['dog'] }, bark: str }, ['kind']),
    Pet: object({ name: str }),
    Toy: object({ toy: str }),
    Base: object({ id: str }, ['id']),
    Owner: object({ ownerId: str }),
    Shelter: object({ shelterId: str }),
    // A pair that pins nothing: only a `mapping` pairs a value with one of them.
    Lion: object({ kind: str, roar: str }),
    Wolf: object({ kind: str, howl: str }),
  };
  const doc = (schemas: Record<string, unknown>, paths: Doc = {}, version = openapi) => ({
    openapi: version,
    info: { title: 'Repro', version: '1.0.0' },
    paths: {
      '/picks': { get: { operationId: 'getPick', responses: { '200': okBody(ref('Pick')) } } },
      ...paths,
    },
    components: { schemas: { ...components, ...schemas } },
  });

  const petToy = [ref('Pet'), ref('Toy')];
  const catDog = [ref('Cat'), ref('Dog')];
  const lionWolf = [ref('Lion'), ref('Wolf')];
  const toCatDog = { cat: at('Cat'), dog: at('Dog') };
  const toLionWolf = { lion: at('Lion'), wolf: at('Wolf') };
  const keyword = (mapping?: Doc, propertyName = 'kind'): Doc => ({ propertyName, ...(mapping ? { mapping } : {}) });

  /** The issue's `mapping.json` and `keyword.json`, and the same with no keyword. */
  const mappingPick = { oneOf: petToy, anyOf: catDog, discriminator: keyword(toCatDog) };
  const keywordPick = { oneOf: petToy, anyOf: catDog, discriminator: keyword() };
  const barePick = { oneOf: petToy, anyOf: catDog };
  /** The issue's document: the five components and `GET /picks` returning `Pick`. */
  const issueDoc = (Pick: Doc, version = openapi) => ({
    openapi: version,
    info: { title: 'Repro', version: '1.0.0' },
    paths: { '/picks': { get: { operationId: 'getPick', responses: { '200': okBody(ref('Pick')) } } } },
    components: {
      schemas: { Cat: components.Cat, Dog: components.Dog, Pet: components.Pet, Toy: components.Toy, Pick },
    },
  });
  /** What the issue's script prints for one document. */
  const printed = (spec: ApiSpec) => {
    const { discriminator, fields } = model(spec, 'Pick');
    return { discriminator, fields: fields.map(({ name }) => name) };
  };
  const dispatched = { property: 'kind', mapping: { cat: 'Cat', dog: 'Dog' } };
  /** `keyword.json`'s `Pick`, the reading `mapping.json` is to have. */
  const expected = '{ name?: string, toy?: string } by kind { cat: Cat, dog: Dog }';

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

  describe('the issue', () => {
    it('`mapping.json` prints what `keyword.json` prints: the oneOf’s properties, dispatching to `Cat` and `Dog`', async () => {
      const mapping = await read(issueDoc(mappingPick));
      const bare = await read(issueDoc(keywordPick));
      // The base printed `fields: []` for `mapping.json`.
      expect(printed(mapping.spec)).toEqual({ discriminator: dispatched, fields: ['name', 'toy'] });
      expect(printed(bare.spec)).toEqual({ discriminator: dispatched, fields: ['name', 'toy'] });
      expect(mapping.spec).toEqual(bare.spec);
      expect(mapping.warnings).toEqual([]);
      expect(bare.warnings).toEqual([]);
    });

    it('`oagen diff` between `keyword.json` and `mapping.json` exits 0, in either direction', async () => {
      const mapping = await write(issueDoc(mappingPick));
      const bare = await write(issueDoc(keywordPick));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      for (const [from, to] of [
        [bare, mapping],
        [mapping, bare],
      ]) {
        const error = (await diffCommand({ old: from, new: to }).catch((e: unknown) => e)) as { exitCode: number };
        expect(error.exitCode).toBe(0);
      }
    });

    it('reads the same with the anyOf written before the oneOf, and with no keyword at all', async () => {
      const { spec } = await expectSameReading(
        issueDoc(mappingPick),
        issueDoc({ discriminator: mappingPick.discriminator, anyOf: catDog, oneOf: petToy }),
      );
      await expectSameReading(issueDoc(mappingPick), issueDoc(barePick));
      expect(reads(spec, 'Pick')).toBe(expected);
      expect(model(spec, 'Pick').variants).toBeUndefined();
    });

    it('reads the same in OAS 3.0.3 and 3.1.0', async () => {
      const older = await read(issueDoc(mappingPick, '3.0.3'));
      const newer = await read(issueDoc(mappingPick, '3.1.0'));
      expect(older.spec.models).toEqual(newer.spec.models);
      expect(diffSpecs(older.spec, newer.spec).changes).toEqual([]);
      expect(diffSpecs(newer.spec, older.spec).changes).toEqual([]);
    });

    it('a model naming the component gets what `keyword.json` gives it, not the base’s fields alone', async () => {
      const naming = (Pick: Doc) => doc({ Pick, Combo: { allOf: [ref('Base'), ref('Pick')] } });
      const { spec } = await expectSameReading(naming(mappingPick), naming(keywordPick));
      // The base gave `Combo { id }` in `mapping.json`.
      expect(reads(spec, 'Combo')).toBe('{ id: string, name?: string, toy?: string } by kind { cat: Cat, dog: Dog }');
      expect(basesOf(model(spec, 'Combo'))).toEqual(['Base', 'Pick']);
    });

    it('the same schema inline is `{ name?, toy?, kind?, meow?, bark? }` in both documents: no inline `allOf` dispatches', async () => {
      const inline = (Pick: Doc) => doc({ Pick, Holder: object({ pick: Pick }) });
      const { spec } = await expectSameReading(inline(mappingPick), inline(keywordPick));
      expect(reads(spec, 'HolderPick')).toBe(
        '{ name?: string, toy?: string, kind?: HolderPickKind, meow?: string, bark?: string }',
      );
      expect(spec.enums.find((e) => e.name === 'HolderPickKind')?.values.map((v) => v.value)).toEqual(['cat', 'dog']);
    });
  });

  describe('every site', () => {
    /** The schema as a component and inline at every site a schema can be written at. */
    const sites = (s: Doc) => {
      const merged = { allOf: [ref('Base'), s] };
      const holder = object({
        pick: s,
        picks: { type: 'array', items: s },
        byName: { type: 'object', additionalProperties: s },
        either: { oneOf: [s, { type: 'boolean' }] },
        maybe: { oneOf: [s, nullVariant] },
        lone: { allOf: [s] },
        merged,
      });
      const created = { description: 'ok', headers: { 'X-Pick': { schema: s } }, content: json(s) };
      const createPick = {
        operationId: 'createPick',
        parameters: [{ name: 'filter', in: 'query', schema: s }],
        requestBody: { required: true, content: json(s) },
        responses: { '200': created, '400': okBody(s) },
      };
      const onPicked = {
        operationId: 'onPicked',
        requestBody: { content: json(s) },
        responses: { '200': okBody(str) },
      };
      return {
        ...doc(
          { Pick: s, Picks: { type: 'array', items: s }, Holder: holder },
          {
            '/holders': { get: { operationId: 'getHolder', responses: { '200': okBody(ref('Holder')) } } },
            '/create': { post: createPick },
            '/list': { get: { operationId: 'listPicks', responses: { '200': okBody(ref('Picks')) } } },
          },
        ),
        // A webhook is an OAS 3.1 section.
        ...(openapi === '3.0.3' ? {} : { webhooks: { picked: { post: onPicked } } }),
      };
    };
    const flattened = ['name?: string', 'toy?: string', 'meow?: string', 'bark?: string'];

    it('a field, items, map values, a union’s variant, a wrapper, a parameter, a header, a body and a webhook read the three documents alike', async () => {
      const { spec, warnings } = await expectSameReading(sites(mappingPick), sites(keywordPick));
      await expectSameReading(sites(mappingPick), sites(barePick));
      expect(warnings).toEqual([]);
      // The component dispatches; no inline site does: each is one model of every variant's properties.
      expect(reads(spec, 'Pick')).toBe(expected);
      const inline = [
        'HolderPick',
        'HolderPicksItem',
        'HolderByName',
        'HolderEither',
        'HolderMaybe',
        'HolderLone',
        'PickItem',
        'CreatePickRequest',
        'CreatePickResponse',
        'CreateFilter',
        'CreateXPick',
        ...(openapi === '3.0.3' ? [] : ['OnPickedPayload']),
      ];
      for (const name of inline) {
        expect(model(spec, name).discriminator, name).toBeUndefined();
        expect(
          fieldsOf(model(spec, name)).filter((field) => !field.startsWith('kind?')),
          name,
        ).toEqual(flattened);
        expect(model(spec, name).fields.map((f) => f.name)).toContain('kind');
      }
      expect(fieldsOf(model(spec, 'HolderMerged')).filter((field) => !field.startsWith('kind?'))).toEqual([
        'id: string',
        ...flattened,
      ]);
    });
  });

  describe('wherever the keyword is written', () => {
    /** Every spelling of the two unions and the keyword that says which of them dispatches. */
    const spellings = (oneOf: unknown[], anyOf: unknown[], discriminator: Doc): Array<[string, Doc]> => [
      ['beside the two unions', { oneOf, anyOf, discriminator }],
      ['beside the two unions, the anyOf first', { discriminator, anyOf, oneOf }],
      [
        'beside the two unions and an `allOf` that only annotates',
        { allOf: [{ description: 'A pick.' }], oneOf, anyOf, discriminator },
      ],
      ['beside the `allOf` of the two', { allOf: [{ oneOf }, { anyOf }], discriminator }],
      ['beside the `allOf` of the two, the anyOf first', { allOf: [{ anyOf }, { oneOf }], discriminator }],
      ['on the oneOf member', { allOf: [{ oneOf, discriminator }, { anyOf }] }],
      ['on the anyOf member', { allOf: [{ oneOf }, { anyOf, discriminator }] }],
    ];
    const everySite = (Pick: Doc) =>
      doc({
        Pick,
        Combo: { allOf: [ref('Base'), ref('Pick')] },
        Inline: { allOf: [ref('Base'), Pick] },
        Alias: ref('Pick'),
        Holder: object({ pick: Pick, merged: { allOf: [ref('Base'), ref('Pick')] } }),
      });

    it.each(spellings(petToy, catDog, keyword(toCatDog)))(
      'a mapping naming the anyOf’s variants, %s: `keyword.json`’s `Pick`',
      async (_label, Pick) => {
        const { spec, warnings } = await read(everySite(Pick));
        expect(warnings).toEqual([]);
        expect(reads(spec, 'Pick')).toBe(expected);
        // Every model that reads the unions carries the flattened one's properties.
        for (const name of ['Combo', 'Inline', 'HolderMerged']) {
          expect(fieldsOf(model(spec, name)), name).toEqual(['id: string', 'name?: string', 'toy?: string']);
        }
        expect(fieldsOf(model(spec, 'Alias'))).toEqual(['name?: string', 'toy?: string']);
        // On a field no `allOf` dispatches: every variant's properties, in either order of the members.
        expect([...fieldsOf(model(spec, 'HolderPick'))].sort()).toEqual([
          'bark?: string',
          'kind?: HolderPickKind',
          'meow?: string',
          'name?: string',
          'toy?: string',
        ]);
        expect(model(spec, 'HolderPick').discriminator).toBeUndefined();
      },
    );

    it('the two unions written beside each other dispatch for a model naming the component; the `allOf` of the two keeps its dispatcher to itself', async () => {
      const [beside, , annotated, wrapper, , onOneOf, onAnyOf] = spellings(petToy, catDog, keyword(toCatDog));
      for (const [label, Pick] of [beside!, annotated!]) {
        const { spec } = await read(everySite(Pick));
        for (const name of ['Combo', 'Inline', 'Alias']) {
          expect(model(spec, name).discriminator, `${label}: ${name}`).toEqual(dispatched);
        }
      }
      // A component its `allOf` composes is read as a component by a model naming it: the base fields only.
      for (const [label, Pick] of [wrapper!, onOneOf!, onAnyOf!]) {
        const { spec } = await read(everySite(Pick));
        for (const name of ['Combo', 'Alias']) {
          expect(model(spec, name).discriminator, `${label}: ${name}`).toBeUndefined();
        }
      }
    });

    it.each(spellings(petToy, lionWolf, keyword(toLionWolf)))(
      'a mapping that is the only pairing (the variants pin nothing), %s: the anyOf dispatches by it',
      async (_label, Pick) => {
        const { spec, warnings } = await read(everySite(Pick));
        expect(warnings).toEqual([]);
        expect(reads(spec, 'Pick')).toBe('{ name?: string, toy?: string } by kind { lion: Lion, wolf: Wolf }');
        expect(fieldsOf(model(spec, 'HolderMerged'))).toEqual(['id: string', 'name?: string', 'toy?: string']);
      },
    );

    it.each(spellings(petToy, catDog, keyword()))(
      'a keyword with no mapping, %s: the union whose variants pin its property dispatches',
      async (_label, Pick) => {
        const { spec, warnings } = await read(everySite(Pick));
        expect(warnings).toEqual([]);
        expect(reads(spec, 'Pick')).toBe(expected);
      },
    );

    it.each(spellings(catDog, petToy, keyword(toCatDog)))(
      'a mapping naming the oneOf’s variants, %s: the oneOf dispatches, as before',
      async (_label, Pick) => {
        const { spec, warnings } = await read(everySite(Pick));
        expect(warnings).toEqual([]);
        expect(reads(spec, 'Pick')).toBe(expected);
      },
    );

    it('every spelling of one pair of unions and one keyword is one reading of `Pick`', async () => {
      for (const discriminator of [
        keyword(toCatDog),
        keyword(),
        keyword({ cat: 'Cat' }),
        keyword({ x: at('Owner') }),
      ]) {
        const [first, ...rest] = spellings(petToy, catDog, discriminator);
        const a = await read(doc({ Pick: first![1] }));
        for (const [label, Pick] of rest) {
          // The member order decides only where the keyword names no variant of either union.
          if (
            discriminator.mapping !== undefined &&
            !('cat' in (discriminator.mapping as Doc)) &&
            label.includes('anyOf')
          )
            continue;
          const b = await read(doc({ Pick }));
          expect(reads(b.spec, 'Pick'), `${JSON.stringify(discriminator)} ${label}`).toBe(reads(a.spec, 'Pick'));
        }
      }
    });
  });

  describe('which union the keyword goes with', () => {
    const pick = async (Pick: Doc, extra: Record<string, unknown> = {}) => {
      const { spec, warnings } = await read(doc({ Pick, ...extra }));
      return { reading: reads(spec, 'Pick'), spec, warnings };
    };

    it('the union more of whose variants the mapping names', async () => {
      // Both unions list `Cat`; the `anyOf` lists `Dog` too.
      const { reading } = await pick({
        oneOf: [ref('Cat'), ref('Pet')],
        anyOf: catDog,
        discriminator: keyword(toCatDog),
      });
      expect(reading).toBe('{ kind?: "cat", meow?: string, name?: string } by kind { cat: Cat, dog: Dog }');
    });

    it('a mapping naming only some of one union’s variants still names that union', async () => {
      const some = await pick({ oneOf: petToy, anyOf: catDog, discriminator: keyword({ cat: at('Cat') }) });
      expect(some.reading).toBe('{ name?: string, toy?: string } by kind { cat: Cat }');
      // An entry naming a schema outside both unions is kept as written, as on any union.
      const outside = await pick({
        oneOf: petToy,
        anyOf: catDog,
        discriminator: keyword({ cat: at('Cat'), z: at('Owner') }),
      });
      expect(outside.reading).toBe('{ name?: string, toy?: string } by kind { cat: Cat, z: Owner }');
    });

    it('naming as many variants of each, the union more of whose variants pin a mapped value', async () => {
      // `Pet` of the `oneOf` and `Cat` of the `anyOf` are named; `Cat` pins `cat`, a value the mapping lists.
      const { reading } = await pick({
        oneOf: petToy,
        anyOf: catDog,
        discriminator: keyword({ cat: at('Cat'), pet: at('Pet') }),
      });
      expect(reading).toBe('{ name?: string, toy?: string } by kind { cat: Cat, pet: Pet }');
    });

    it('selecting the two alike, the first of them: the oneOf, whichever is written first', async () => {
      const tie = keyword({ pet: at('Pet'), lion: at('Lion') });
      const anyOf = [ref('Lion'), ref('Owner')];
      const expectedTie = '{ kind?: string, roar?: string, ownerId?: string } by kind { pet: Pet, lion: Lion }';
      expect((await pick({ oneOf: petToy, anyOf, discriminator: tie })).reading).toBe(expectedTie);
      expect((await pick({ discriminator: tie, anyOf, oneOf: petToy })).reading).toBe(expectedTie);
    });

    it('naming no variant of either, the first of them dispatches as written and the other is flattened', async () => {
      const { reading, warnings } = await pick({
        oneOf: petToy,
        anyOf: catDog,
        discriminator: keyword({ x: at('Owner'), y: at('Shelter') }),
      });
      // The base dispatched to `Cat` and `Dog` by the `anyOf`'s pinned consts, with no field.
      expect(reading).toBe('{ kind?: PickKind, meow?: string, bark?: string } by kind { x: Owner, y: Shelter }');
      expect(warnings).toEqual([]);
    });

    it('a mapping naming the oneOf’s variants keeps the anyOf from dispatching by its pinned consts', async () => {
      // One `Model.discriminator`: the keyword says which union dispatches, and the other is flattened.
      const { reading, spec } = await pick(
        { oneOf: petToy, anyOf: catDog, discriminator: keyword({ pet: at('Pet'), toy: at('Toy') }) },
        { Combo: { allOf: [ref('Base'), ref('Pick')] } },
      );
      // The base read both unions as dispatched: `Pick {}` dispatching to `Cat` and `Dog`.
      expect(reading).toBe('{ kind?: PickKind, meow?: string, bark?: string } by kind { pet: Pet, toy: Toy }');
      expect(reads(spec, 'Combo')).toBe(
        '{ id: string, kind?: ComboKind, meow?: string, bark?: string } by kind { pet: Pet, toy: Toy }',
      );
    });

    describe('with no mapping', () => {
      it('the union whose variants each pin the property, read by that property', async () => {
        // The `anyOf`'s variants pin `type` before `kind`; the keyword names `kind`.
        const { reading } = await pick(
          { oneOf: petToy, anyOf: [ref('A'), ref('B')], discriminator: keyword() },
          {
            A: object({ type: pinned('a'), kind: pinned('lion'), roar: str }, ['kind']),
            B: object({ type: pinned('b'), kind: pinned('wolf'), howl: str }, ['kind']),
          },
        );
        // The base handed the keyword to the `oneOf` and dispatched the `anyOf` by `type`.
        expect(reading).toBe('{ name?: string, toy?: string } by kind { lion: A, wolf: B }');
      });

      it('a property no union pins dispatches nothing, as on one union: both are flattened', async () => {
        const { reading } = await pick(
          { oneOf: petToy, anyOf: [ref('A'), ref('B')], discriminator: keyword() },
          { A: object({ type: pinned('a'), roar: str }), B: object({ type: pinned('b'), howl: str }) },
        );
        expect(reading).toBe('{ name?: string, toy?: string, type?: PickType, roar?: string, howl?: string }');
        // The one union alone under the same keyword is flattened too: the document names the property.
        const alone = await pick(
          { allOf: [ref('Base'), { anyOf: [ref('A'), ref('B')], discriminator: keyword() }] },
          { A: object({ type: pinned('a'), roar: str }), B: object({ type: pinned('b'), howl: str }) },
        );
        expect(alone.reading).toBe('{ id: string, type?: PickType, roar?: string, howl?: string }');
      });
    });

    describe('however a target is written', () => {
      const cases: Array<[string, Doc, Doc, Record<string, unknown>, string]> = [
        ['a bare schema name', { cat: 'Cat', dog: 'Dog' }, { anyOf: catDog }, {}, 'cat: Cat, dog: Dog'],
        [
          'an alias of the variant’s component',
          { cat: at('Kitty'), dog: at('Pup') },
          { anyOf: catDog },
          { Kitty: ref('Cat'), Pup: ref('Dog') },
          'cat: Cat, dog: Dog',
        ],
        [
          'the component a variant aliases',
          toCatDog,
          { anyOf: [ref('Kitty'), ref('Pup')] },
          { Kitty: ref('Cat'), Pup: ref('Dog') },
          'cat: Cat, dog: Dog',
        ],
        [
          'a pointer the variant is written as',
          { cat: at('Zoo/properties/cat'), dog: at('Zoo/properties/dog') },
          { anyOf: [ref('Zoo/properties/cat'), ref('Zoo/properties/dog')] },
          { Zoo: object({ cat: components.Cat, dog: components.Dog }) },
          'cat: ZooCat, dog: ZooDog',
        ],
        [
          'a percent-encoded reference',
          { cat: at('Big%20Cat'), dog: at('Dog') },
          { anyOf: [ref('Big%20Cat'), ref('Dog')] },
          { 'Big Cat': components.Cat },
          'cat: BigCat, dog: Dog',
        ],
        [
          'a reference each variant wraps in an `allOf`',
          toCatDog,
          { anyOf: [{ allOf: [ref('Cat')] }, { allOf: [ref('Dog')] }] },
          {},
          'cat: Cat, dog: Dog',
        ],
        ['beside a `null` variant', toCatDog, { anyOf: [...catDog, nullVariant] }, {}, 'cat: Cat, dog: Dog'],
      ];

      it.each(cases)('%s names the variant', async (_label, mapping, union, extra, entries) => {
        const { reading, warnings } = await pick({ oneOf: petToy, ...union, discriminator: keyword(mapping) }, extra);
        expect(reading).toBe(`{ name?: string, toy?: string } by kind { ${entries} }`);
        expect(warnings).toEqual([]);
      });

      it('inline variants are named by the value each pins: the mapping’s targets are kept as written', async () => {
        const inlineCat = object({ kind: pinned('cat'), meow: str }, ['kind']);
        const inlineDog = object({ kind: pinned('dog'), bark: str }, ['kind']);
        const { reading, spec } = await pick({
          oneOf: petToy,
          anyOf: [inlineCat, inlineDog],
          discriminator: keyword(toCatDog),
        });
        expect(reading).toBe(expected);
        // With no mapping the inline variants are the dispatcher's own models, the flattened union their base.
        const own = await pick({ oneOf: petToy, anyOf: [inlineCat, inlineDog], discriminator: keyword() });
        expect(own.reading).toBe('{ name?: string, toy?: string } by kind { cat: PickCat, dog: PickDog }');
        expect(reads(own.spec, 'PickCat')).toBe('{ name?: string, toy?: string, kind: "cat", meow?: string }');
        expect(reads(own.spec, 'PickDog')).toBe('{ name?: string, toy?: string, kind: "dog", bark?: string }');
        expect(spec.models.map((m) => m.name)).toContain('Pick');
      });

      it('references into another file, and into this one by its file name, name the variants they resolve to', async () => {
        await write(
          { Cat: components.Cat, Dog: components.Dog },
          'pets.json', // beside the document
        );
        const documents: Array<[string, Doc]> = [
          [
            'another file',
            {
              oneOf: petToy,
              anyOf: [{ $ref: './pets.json#/Cat' }, { $ref: './pets.json#/Dog' }],
              discriminator: keyword({ cat: './pets.json#/Cat', dog: './pets.json#/Dog' }),
            },
          ],
          [
            'this file by name',
            {
              oneOf: petToy,
              anyOf: catDog,
              discriminator: keyword({
                cat: './main.json#/components/schemas/Cat',
                dog: './main.json#/components/schemas/Dog',
              }),
            },
          ],
        ];
        for (const [label, Pick] of documents) {
          const spec = await parseSpec(await write(issueDoc(Pick), 'main.json'));
          expect(reads(spec, 'Pick'), label).toBe(expected);
        }
      });
    });
  });

  describe('every union the component reads as its own', () => {
    it('a union under a nullable wrapper is the union the mapping names', async () => {
      const { spec } = await read(
        doc({ Pick: { oneOf: petToy, anyOf: [{ anyOf: catDog }, nullVariant], discriminator: keyword(toCatDog) } }),
      );
      expect(reads(spec, 'Pick')).toBe(expected);
    });

    it('a nullable wrapper around no union takes no keyword: the one union beside it dispatches by the mapping', async () => {
      const { spec } = await read(
        doc({ Pick: { oneOf: [ref('Pet'), nullVariant], anyOf: lionWolf, discriminator: keyword(toLionWolf) } }),
      );
      // The base handed the keyword to the wrapper, and `Lion` and `Wolf`, which pin nothing, were flattened.
      expect(reads(spec, 'Pick')).toBe('{ name?: string } by kind { lion: Lion, wolf: Wolf }');
      expect(basesOf(model(spec, 'Pick'))).toEqual(['Pet']);
    });

    it('three unions: the one the mapping names dispatches, the other two are flattened', async () => {
      const members = [{ oneOf: petToy }, { oneOf: [ref('Owner'), ref('Shelter')] }, { anyOf: catDog }];
      const { spec } = await read(doc({ Pick: { allOf: members, discriminator: keyword(toCatDog) } }));
      // The base made all three dispatchers by the one mapping: `Pick {}`.
      expect(reads(spec, 'Pick')).toBe(
        '{ name?: string, toy?: string, ownerId?: string, shelterId?: string } by kind { cat: Cat, dog: Dog }',
      );
    });

    it('unions behind `$ref` members: the keyword beside the `allOf` goes with the one it names, in the model and in a merge naming it', async () => {
      const { spec } = await read(
        doc({
          // `ChoiceA`'s variants pin `type`: no dispatcher beside a keyword that names `ChoiceB`'s.
          A: object({ type: pinned('a'), roar: str }, ['type']),
          B: object({ type: pinned('b'), howl: str }, ['type']),
          ChoiceA: { oneOf: [ref('A'), ref('B')] },
          ChoiceB: { anyOf: catDog },
          Pick: { allOf: [ref('Base'), ref('ChoiceA'), ref('ChoiceB')], discriminator: keyword(toCatDog) },
          Holder: object({ merged: { allOf: [ref('Pick'), object({ x: str })] } }),
        }),
      );
      expect(reads(spec, 'Pick')).toBe(
        '{ id: string, type?: PickType, roar?: string, howl?: string } by kind { cat: Cat, dog: Dog }',
      );
      // The merge leaves the dispatched union to `Pick` and carries the flattened one, as `Pick` does.
      expect(fieldsOf(model(spec, 'HolderMerged'))).toEqual([
        'id: string',
        'type?: HolderMergedType',
        'roar?: string',
        'howl?: string',
        'x?: string',
      ]);
    });

    it('unions beside a typing `allOf`, and one among its members: one reading wherever the keyword and the named union sit', async () => {
      const k = keyword(toCatDog);
      const spelled: Array<[string, Doc]> = [
        [
          '`properties` beside the two',
          { ...object({ id: str }, ['id']), oneOf: petToy, anyOf: catDog, discriminator: k },
        ],
        ['an `allOf` beside the two', { allOf: [ref('Base')], oneOf: petToy, anyOf: catDog, discriminator: k }],
        [
          'the named union beside, the other a member',
          { allOf: [ref('Base'), { oneOf: petToy }], anyOf: catDog, discriminator: k },
        ],
        [
          'the named union a member, the other beside',
          { allOf: [ref('Base'), { anyOf: catDog }], oneOf: petToy, discriminator: k },
        ],
      ];
      for (const [label, Pick] of spelled) {
        const { spec } = await read(
          doc({ Pick, Holder: object({ merged: { allOf: [ref('Pick'), object({ x: str })] } }) }),
        );
        expect(reads(spec, 'Pick'), label).toBe(
          '{ id: string, name?: string, toy?: string } by kind { cat: Cat, dog: Dog }',
        );
        expect(fieldsOf(model(spec, 'HolderMerged')), label).toEqual([
          'id: string',
          'name?: string',
          'toy?: string',
          'x?: string',
        ]);
      }
    });

    it('a model naming the component with a keyword of its own beside its `allOf` dispatches the union it names', async () => {
      const { spec } = await read(
        doc({ Pick: barePick, Combo: { allOf: [ref('Base'), ref('Pick')], discriminator: keyword(toCatDog) } }),
      );
      // The base handed the keyword to both of `Pick`'s unions: `Combo { id }`.
      expect(reads(spec, 'Combo')).toBe('{ id: string, name?: string, toy?: string } by kind { cat: Cat, dog: Dog }');
    });

    it('two keywords: the first a union is written with is the component’s, and goes with the union it names', async () => {
      const onEach = {
        allOf: [
          { oneOf: petToy, discriminator: keyword(toCatDog) },
          { anyOf: catDog, discriminator: keyword() },
        ],
      };
      const memberAndWrapper = {
        allOf: [{ oneOf: petToy }, { anyOf: catDog, discriminator: keyword() }],
        discriminator: keyword({ pet: at('Pet'), toy: at('Toy') }),
      };
      for (const Pick of [onEach, memberAndWrapper]) {
        const { spec } = await read(doc({ Pick }));
        expect(reads(spec, 'Pick')).toBe(expected);
      }
    });

    it('pagination: a stop field the flattened union’s variants declare resolves behind a merge naming the model, as it does with no mapping', async () => {
      const bool = { type: 'boolean' };
      const endOfIteration = { kind: 'hasMore', path: 'meta.has_more' };
      const listing = (discriminator: Doc) =>
        doc(
          {
            StopA: object({ has_more: bool, a: str }),
            StopB: object({ has_more: bool, b: str }),
            Pick: { oneOf: [ref('StopA'), ref('StopB')], anyOf: catDog, discriminator },
            Combo: { allOf: [ref('Base'), ref('Pick')] },
          },
          {
            '/list': {
              get: {
                operationId: 'listPicks',
                parameters: [{ name: 'after', in: 'query', schema: str }],
                responses: {
                  '200': okBody(
                    object({
                      data: { type: 'array', items: str },
                      meta: { allOf: [ref('Combo'), object({ trace_id: str })] },
                    }),
                  ),
                },
                'x-pagination': { endOfIteration },
              },
            },
          },
        );
      const { spec, warnings } = await expectSameReading(listing(keyword(toCatDog)), listing(keyword()));
      const listPicks = spec.services.flatMap((s) => s.operations).find((o) => o.name === 'listPicks')!;
      // The base read the `oneOf` as dispatched under the mapping, and the path resolved to no field.
      expect(listPicks.pagination?.endOfIteration).toEqual(endOfIteration);
      expect(warnings).toEqual([]);
    });
  });

  describe('what is read as it was', () => {
    it('one union alone keeps the keyword it is written with, a mapping naming schemas outside it included', async () => {
      const outside = keyword(toCatDog);
      const { spec } = await read(
        doc({
          Pick: { allOf: [ref('Base'), { oneOf: petToy, discriminator: outside }] },
          Named: { oneOf: petToy, discriminator: outside },
          Wrapped: { allOf: [ref('Base'), { oneOf: catDog }], discriminator: keyword() },
        }),
      );
      expect(reads(spec, 'Pick')).toBe('{ id: string } by kind { cat: Cat, dog: Dog }');
      expect(model(spec, 'Named').variants?.map(show)).toEqual(['Pet', 'Toy']);
      expect(model(spec, 'Named').discriminator).toEqual(dispatched);
      expect(reads(spec, 'Wrapped')).toBe('{ id: string } by kind { cat: Cat, dog: Dog }');
    });

    it('a union of bare limits is no union a keyword goes with', async () => {
      const { spec } = await read(
        doc({
          Pick: {
            ...object({ a: str, b: str }),
            oneOf: [{ required: ['a'] }, { required: ['b'] }],
            anyOf: catDog,
            discriminator: keyword(toCatDog),
          },
        }),
      );
      expect(reads(spec, 'Pick')).toBe('{ a?: string, b?: string } by kind { cat: Cat, dog: Dog }');
    });

    it('a keyword that names no property decides nothing', async () => {
      for (const discriminator of [{}, 'kind']) {
        const { spec } = await read(doc({ Pick: { oneOf: petToy, anyOf: catDog, discriminator } }));
        expect(reads(spec, 'Pick')).toBe(expected);
      }
    });

    it('two unions that compose nothing: the anyOf is not read (#680), and the keyword stays with the oneOf', async () => {
      const arrays = (name: string) => [{ type: 'array', items: ref(name) }];
      const { spec, warnings } = await read(
        doc({ Pick: { oneOf: arrays('Pet'), anyOf: arrays('Cat'), discriminator: keyword({ cat: at('Cat') }) } }),
      );
      expect(model(spec, 'Pick').variants?.map(show)).toEqual(['Pet[]']);
      expect(model(spec, 'Pick').discriminator).toEqual({ property: 'kind', mapping: { cat: 'Cat' } });
      expect(warnings).toEqual([expect.stringContaining('`anyOf` beside `oneOf` is not read')]);
    });

    it('one `$ref` each compose (#717), so the keyword goes with the union its `mapping` names', async () => {
      // Read as two unions that compose nothing before #717: the union of `Pet`, the keyword left with it.
      const { spec, warnings } = await read(
        doc({ Pick: { oneOf: [ref('Pet')], anyOf: [ref('Cat')], discriminator: keyword({ cat: at('Cat') }) } }),
      );
      expect(model(spec, 'Pick').variants).toBeUndefined();
      expect(reads(spec, 'Pick')).toBe('{ name?: string } by kind { cat: Cat }');
      expect(warnings).toEqual([]);
    });
  });

  describe('the one decision', () => {
    const schemas = components as Record<string, SchemaObject>;

    it('`axisDiscriminatorOf` answers the keyword for the union it goes with, and the decision for the other', () => {
      const discriminator = { propertyName: 'kind', mapping: toCatDog };
      const both: SchemaObject = { oneOf: petToy, anyOf: catDog, discriminator };
      expect(axisDiscriminatorOf(both, both.anyOf!, undefined, schemas)).toBe(discriminator);
      const other = axisDiscriminatorOf(both, both.oneOf!, undefined, schemas);
      expect(other).toEqual(discriminator);
      expect(isDecidedDiscriminator(other)).toBe(true);
      // A decision handed down is the answer for every union under it, whatever the schema writes itself.
      const lone: SchemaObject = { oneOf: lionWolf, discriminator: { propertyName: 'type' } };
      expect(axisDiscriminatorOf(lone, lone.oneOf!, other, schemas)).toBe(other);
      expect(axisDiscriminatorOf(lone, lone.oneOf!, discriminator, schemas)).toBe(lone.discriminator);
      expect(axisDiscriminatorOf({ oneOf: lionWolf }, [], discriminator, schemas)).toBe(discriminator);
    });

    it('`wrapperDiscriminatorOf` decides for a schema that composes several unions, and hands one union its keyword as written', () => {
      const discriminator = { propertyName: 'kind', mapping: toCatDog };
      const several: SchemaObject = { allOf: [{ oneOf: petToy }, { anyOf: catDog }], discriminator };
      const decided = wrapperDiscriminatorOf(several, schemas);
      expect(decided).toEqual(discriminator);
      expect(isDecidedDiscriminator(decided)).toBe(true);
      // Asked again, the same decision.
      expect(wrapperDiscriminatorOf(several, schemas)).toBe(decided);
      const one: SchemaObject = { allOf: [ref('Base'), { anyOf: catDog }], discriminator };
      expect(wrapperDiscriminatorOf(one, schemas)).toBe(discriminator);
      // Beside a `$ref` nothing but annotations is read (#618).
      expect(wrapperDiscriminatorOf({ ...ref('Pet'), discriminator } as SchemaObject, schemas)).toBeUndefined();
      expect(isDecidedDiscriminator(undefined)).toBe(false);
    });
  });
});
