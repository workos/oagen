import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { besideUnionsCompose, classifyInlineSchema } from '../../src/parser/schemas.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import {
  conjoinsObjectMember,
  declaresInlineProperties,
  readInlineAllOf,
  referencesThroughUnion,
  unionReferencesOf,
} from '../../src/parser/inline-models.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #717: the weighers of an inline `allOf` counted a `$ref` written as
 * a union's variant only under a union of two or more variants, so a member
 * `{ oneOf: [{ $ref: Pet }] }` — or a nullable wrapper around one — counted
 * neither as a reference nor as a member that brings properties. Beside
 * another such member the `allOf` was `unknown`; beside a `$ref` member it
 * was that reference alone, `Pet` dropped without a word; and a `oneOf` of
 * one `$ref` beside an `anyOf` of one was two unions that compose nothing,
 * typed by the `oneOf` alone. The same schemas as components were the
 * merged model. A member that names a component through a union of its own
 * is one of the objects the `allOf` conjoins, as a `$ref` member is,
 * however many variants the union holds.
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
/** A union of one `$ref`. */
const one = (name: string, keyword: 'oneOf' | 'anyOf' = 'oneOf'): Doc => ({ [keyword]: [ref(name)] });

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

describe.each(['3.1.0', '3.0.3'])('#717 an allOf member that is a union of one $ref (OAS %s)', (openapi) => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let written = 0;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-717-'));
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
  const basesOf = (m: Model) => m.bases?.map(show);
  const modelNames = (spec: ApiSpec) => spec.models.map((m) => m.name);
  /** A model as one line: its name, its fields, and what else it is. */
  const describeModel = (m: Model): string =>
    [
      `${m.name} { ${fieldsOf(m).join(', ')} }`,
      m.variants ? `${m.compositionKind} ${show({ kind: 'union', variants: m.variants })}` : '',
      m.discriminator ? `by ${m.discriminator.property} ${JSON.stringify(m.discriminator.mapping)}` : '',
      m.bases ? `bases [${basesOf(m)!.join(', ')}]` : '',
    ]
      .filter(Boolean)
      .join(' ');

  /** The `null` variant a union lists, in this version's spelling. */
  const nullVariant = openapi === '3.0.3' ? { enum: [null] } : { type: 'null' };
  /** A nullable wrapper around one `$ref`. */
  const nul = (name: string, keyword: 'oneOf' | 'anyOf' = 'oneOf'): Doc => ({ [keyword]: [ref(name), nullVariant] });
  /** The OAS 3.0 spelling of the same wrapper: the flag standing for the `null` variant (#677). */
  const flagged = (name: string): Doc => ({ oneOf: [ref(name)], nullable: true });
  /** A property pinned to one string, in this version's spelling. */
  const pinned = (value: string) =>
    openapi === '3.0.3' ? { type: 'string', enum: [value] } : { type: 'string', const: value };
  /** An object that admits `null`, in this version's spelling. */
  const nullableObject = (properties: Doc): Doc =>
    openapi === '3.0.3' ? { type: 'object', nullable: true, properties } : { type: ['object', 'null'], properties };

  const components: Record<string, Doc> = {
    Owner: object({ ownerId: str }),
    Pet: object({ name: str }),
    Shelter: object({ shelterId: str }),
    Toy: object({ toy: str }),
    Base: object({ id: str }, ['id']),
    Tag: object({ label: str }),
  };
  const known = new Set([...Object.keys(components), 'Holder']);
  const getBase = { '/base': { get: { operationId: 'getBase', responses: { '200': okBody(ref('Base')) } } } };
  const doc = (schemas: Record<string, unknown>, paths: Doc = {}, extra: Doc = {}) => ({
    openapi,
    info: { title: 'Repro', version: '1.0.0' },
    paths: { ...getBase, ...paths },
    components: { schemas: { ...components, ...schemas } },
    ...extra,
  });
  /** `schema` as the component `Comp`, a `$ref` to it, and the same schema written on a field. */
  const twins = (schema: unknown, schemas: Record<string, unknown> = {}) =>
    doc({ ...schemas, Comp: schema, Holder: object({ field: schema, named: ref('Comp') }) });
  /** What the twins are: the component's fields, how a `$ref` to it is typed, and the field with the model it names. */
  const twinReading = (spec: ApiSpec) => {
    const holder = model(spec, 'Holder');
    const field = holder.fields.find((f) => f.name === 'field')!.type;
    const named = holder.fields.find((f) => f.name === 'named')!.type;
    const inner = field.kind === 'nullable' ? field.inner : field;
    const minted = inner.kind === 'model' && !known.has(inner.name) && inner.name !== 'Comp';
    return {
      component: fieldsOf(model(spec, 'Comp')),
      named: show(named),
      field: show(field),
      inline: minted ? fieldsOf(model(spec, inner.name)) : undefined,
    };
  };
  /** The schema inline is the model the component is: the same fields, and `null` admitted alike. */
  const expectTwins = async (
    schema: unknown,
    fields: string[],
    label: string,
    schemas: Record<string, unknown> = {},
  ) => {
    const { spec, warnings } = await read(twins(structuredClone(schema), schemas));
    const reading = twinReading(spec);
    expect(reading.component, label).toEqual(fields);
    expect(reading.inline, label).toEqual(fields);
    expect(reading.field.startsWith('nullable<'), label).toBe(reading.named.startsWith('nullable<'));
    expect(reading.field.replace(/^nullable<(.*)>$/, '$1'), label).toBe('HolderField');
    expect(warnings, label).toEqual([]);
    return { spec, reading };
  };

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

  const nameOwner = ['name?: string', 'ownerId?: string'];

  describe('the issue', () => {
    const Both = { allOf: [one('Pet'), one('Owner')] };
    const Mixed = { allOf: [one('Pet'), ref('Owner')] };
    const Pick = { allOf: [{ description: 'A pick.' }], oneOf: [ref('Pet')], anyOf: [ref('Owner')] };
    /** The issue's `repro.json`: three components `Holder` also writes inline as its fields. */
    const issueDoc = (pick: Doc = Pick) => ({
      openapi,
      info: { title: 'Repro', version: '1.0.0' },
      paths: { '/holders': { get: { operationId: 'getHolder', responses: { '200': okBody(ref('Holder')) } } } },
      components: {
        schemas: {
          Owner: object({ ownerId: str }),
          Pet: object({ name: str }),
          Both,
          Mixed,
          Pick: pick,
          Holder: object({ both: Both, mixed: Mixed, pick }),
        },
      },
    });
    /** What the issue's script prints. */
    const printed = ({ models }: ApiSpec) => {
      const shown = (type: TypeRef): string =>
        type.kind === 'union'
          ? `(${type.variants.map(shown).join(' | ')})`
          : ((type as { name?: string }).name ?? (type as { type: string }).type);
      return models
        .filter(({ name }) => ['Both', 'Holder', 'Mixed', 'Pick'].includes(name))
        .map(
          ({ fields, name, variants }) =>
            `${name}: ${variants ? `union ${variants.map(shown).join(' | ')}` : `{ ${fields.map((field) => `${field.name}: ${shown(field.type)}`).join(', ')} }`}`,
        );
    };

    it('prints a model of `name` and `ownerId` for each component and for each of `Holder`’s fields, and no warning', async () => {
      const { spec, warnings } = await read(issueDoc());
      // The base printed `Pick: union Pet` and `Holder: { both: unknown, mixed: Owner, pick: (Pet) }`, with
      // two "`anyOf` beside `oneOf` is not read" warnings and one "Unknown schema shape".
      expect(printed(spec)).toEqual([
        'Both: { name: string, ownerId: string }',
        'Mixed: { name: string, ownerId: string }',
        'Pick: { name: string, ownerId: string }',
        'Holder: { both: HolderBoth, mixed: HolderMixed, pick: HolderPick }',
      ]);
      expect(warnings).toEqual([]);
    });

    it('each field of `Holder` is the model its component is', async () => {
      const { spec } = await read(issueDoc());
      for (const [component, inline] of [
        ['Both', 'HolderBoth'],
        ['Mixed', 'HolderMixed'],
        ['Pick', 'HolderPick'],
      ]) {
        expect(fieldsOf(model(spec, component)), component).toEqual(nameOwner);
        expect(fieldsOf(model(spec, inline)), inline).toEqual(nameOwner);
        expect(model(spec, inline).variants, inline).toBeUndefined();
      }
      expect(fieldsOf(model(spec, 'Holder'))).toEqual([
        'both?: HolderBoth',
        'mixed?: HolderMixed',
        'pick?: HolderPick',
      ]);
      // `Pick` is the model it was before #707, no named union of its `oneOf`.
      expect(model(spec, 'Pick').variants).toBeUndefined();
      expect(model(spec, 'Pick').compositionKind).toBeUndefined();
      expect(model(spec, 'Pick').description).toBe('A pick.');
      expect(model(spec, 'HolderPick').description).toBe('A pick.');
    });

    it('`Pick` reads one way with the description beside the unions, in the `allOf`, and with the unions written as members', async () => {
      const plain = { description: 'A pick.', oneOf: [ref('Pet')], anyOf: [ref('Owner')] };
      const member = { description: 'A pick.', allOf: [{ oneOf: [ref('Pet')] }, { anyOf: [ref('Owner')] }] };
      await expectSameReading(issueDoc(Pick), issueDoc(plain));
      await expectSameReading(issueDoc(Pick), issueDoc(member));
      // Either order of the two keywords.
      await expectSameReading(
        issueDoc(plain),
        issueDoc({ anyOf: [ref('Owner')], oneOf: [ref('Pet')], description: 'A pick.' }),
      );
    });

    it('`oagen diff` between the spellings of `Pick` exits 0, in either direction', async () => {
      const spelled = {
        beside: await write(issueDoc(Pick)),
        plain: await write(issueDoc({ description: 'A pick.', oneOf: [ref('Pet')], anyOf: [ref('Owner')] })),
        member: await write(
          issueDoc({ description: 'A pick.', allOf: [{ oneOf: [ref('Pet')] }, { anyOf: [ref('Owner')] }] }),
        ),
      };
      vi.spyOn(console, 'log').mockImplementation(() => {});
      for (const [from, to] of [
        [spelled.plain, spelled.beside],
        [spelled.beside, spelled.plain],
        [spelled.plain, spelled.member],
        [spelled.member, spelled.plain],
      ]) {
        const error = (await diffCommand({ old: from, new: to }).catch((e: unknown) => e)) as { exitCode: number };
        expect(error.exitCode).toBe(0);
      }
    });

    it('`oagen diff` from the one `$ref` to the union of one around it reports a merge, not a dropped member', async () => {
      // `mixed` as `allOf: [{ $ref: Pet }, { $ref: Owner }]` and as the issue writes it differ only in what a
      // union of one makes of `Pet`'s fields: branch-only, as every flattened variant's are.
      const requiring = (mixed: Doc) => ({
        ...issueDoc(),
        components: {
          schemas: {
            Owner: object({ ownerId: str }, ['ownerId']),
            Pet: object({ name: str }, ['name']),
            Holder: object({ mixed }),
          },
        },
      });
      const refs = await read(requiring({ allOf: [ref('Pet'), ref('Owner')] }));
      const union = await read(requiring(Mixed));
      expect(fieldsOf(model(refs.spec, 'HolderMixed'))).toEqual(['name: string', 'ownerId: string']);
      expect(fieldsOf(model(union.spec, 'HolderMixed'))).toEqual(['name?: string', 'ownerId: string']);
    });
  });

  describe('the one answer every weigher asks', () => {
    const pet = ref('Pet') as SchemaObject;
    const owner = ref('Owner') as SchemaObject;

    it('`unionReferencesOf` names every `$ref` a member holds under a union of its own, and none for a `$ref` member', () => {
      const refs = (member: unknown) => unionReferencesOf(member as SchemaObject).map((reference) => reference.$ref);
      expect(refs(pet)).toEqual([]);
      expect(refs({ oneOf: [pet] })).toEqual([at('Pet')]);
      expect(refs({ anyOf: [pet] })).toEqual([at('Pet')]);
      expect(refs({ oneOf: [pet, { type: 'null' }] })).toEqual([at('Pet')]);
      expect(refs({ oneOf: [pet], nullable: true })).toEqual([at('Pet')]);
      expect(refs({ oneOf: [pet, owner] })).toEqual([at('Pet'), at('Owner')]);
      expect(refs({ oneOf: [pet], anyOf: [owner] })).toEqual([at('Pet'), at('Owner')]);
      // Through a union of one around either, and an `allOf` on the way.
      expect(refs({ oneOf: [{ anyOf: [pet] }] })).toEqual([at('Pet')]);
      expect(refs({ oneOf: [{ allOf: [pet, owner] }, { type: 'null' }] })).toEqual([at('Pet'), at('Owner')]);
      expect(refs({ additionalProperties: false, allOf: [{ oneOf: [pet] }] })).toEqual([at('Pet')]);
      // A `$ref` under no union is an `allOf` member's, read by `composesObjectMember` (#675).
      expect(refs({ allOf: [pet] })).toEqual([]);
      expect(refs({ additionalProperties: false, allOf: [pet] })).toEqual([]);
      // Never through a property, an array's items or a map's values.
      expect(refs({ properties: { pet: { oneOf: [pet] } } })).toEqual([]);
      expect(refs({ type: 'array', items: { oneOf: [pet] } })).toEqual([]);
      expect(refs({ oneOf: [{ type: 'string' }, { properties: { a: str } }] })).toEqual([]);
    });

    it('a member that holds itself ends the walk', () => {
      const loop: SchemaObject = { oneOf: [] };
      loop.oneOf!.push(loop, pet);
      expect(unionReferencesOf(loop).map((reference) => reference.$ref)).toEqual([at('Pet')]);
      const around: SchemaObject = { allOf: [] };
      around.allOf!.push({ oneOf: [around] });
      expect(unionReferencesOf(around)).toEqual([]);
      expect(referencesThroughUnion(around)).toBe(false);
    });

    it('one object held outside a union and under it is read in both places (Greptile)', () => {
      // A `transformSpec` hook or a YAML anchor writes one object twice. Read outside the union first, it
      // was skipped under it, so the member named no component where two copies of the object named one.
      const shared = ref('Pet') as SchemaObject;
      const toy = ref('Toy') as SchemaObject;
      const refs = (member: SchemaObject) => unionReferencesOf(member).map((reference) => reference.$ref);
      expect(refs({ allOf: [shared], oneOf: [shared] })).toEqual([at('Pet')]);
      expect(refs({ allOf: [{ ...shared }], oneOf: [{ ...shared }] })).toEqual([at('Pet')]);
      // In either order of the two keywords, and named once however often the unions hold it.
      expect(refs({ oneOf: [shared], allOf: [shared] })).toEqual([at('Pet')]);
      expect(refs({ allOf: [shared, { oneOf: [shared] }], anyOf: [shared] })).toEqual([at('Pet')]);
      // A wrapper held in both places is read again under the union for the `$ref` it holds.
      const wrapper: SchemaObject = { allOf: [shared] };
      expect(refs({ allOf: [wrapper], oneOf: [wrapper] })).toEqual([at('Pet')]);
      // The same guard for the walk that counts a `$ref` on a branch of two or more variants.
      expect(declaresInlineProperties({ allOf: [shared, toy], oneOf: [shared, toy] })).toBe(true);
      expect(declaresInlineProperties({ allOf: [{ ...shared }, { ...toy }], oneOf: [{ ...shared }, { ...toy }] })).toBe(
        true,
      );
      expect(declaresInlineProperties({ allOf: [wrapper], oneOf: [wrapper, { type: 'string' }] })).toBe(true);
      // Outside a union a `$ref` still declares nothing, however often it is held.
      expect(declaresInlineProperties({ allOf: [shared, shared] })).toBe(false);
      expect(refs({ allOf: [shared, shared] })).toEqual([]);
    });

    it('two declarations of one property conjoin whether the member’s `$ref` is one object or two (Greptile)', async () => {
      // `owner` declared as `{ allOf: [X], oneOf: [X] }` beside `{ $ref: Tag }`: with one shared `X = { $ref:
      // Pet }` the conjunction took the first for a member no reader reads and kept it alone, `Tag` lost.
      const document = doc({
        Holder: {
          allOf: [object({ owner: { allOf: [ref('Pet')], oneOf: [ref('Pet')] } }), object({ owner: ref('Tag') })],
        },
      });
      const file = await write(document);
      const copies = await parseSpec(file);
      const shared = await parseSpec(file, {
        transformSpec: (spec) => {
          const holder = (spec.components as { schemas: Record<string, { allOf: Array<{ properties: Doc }> }> }).schemas
            .Holder!;
          const owner = holder.allOf[0]!.properties.owner as { allOf: unknown[]; oneOf: unknown[] };
          owner.oneOf[0] = owner.allOf[0];
          return spec;
        },
      });
      for (const spec of [copies, shared]) {
        expect(fieldsOf(model(spec, 'Holder'))).toEqual(['owner?: HolderOwner']);
        expect(fieldsOf(model(spec, 'HolderOwner'))).toEqual(['name?: string', 'label?: string']);
      }
      expect(shared.models).toEqual(copies.models);
    });

    it('`declaresInlineProperties` is unchanged: a `$ref` under a union of one, or a nullable wrapper, declares none (#555)', () => {
      expect(declaresInlineProperties({ oneOf: [pet] })).toBe(false);
      expect(declaresInlineProperties({ oneOf: [pet, { type: 'null' }] })).toBe(false);
      expect(declaresInlineProperties({ oneOf: [pet, owner] })).toBe(true);
      expect(referencesThroughUnion({ oneOf: [pet] })).toBe(true);
      expect(referencesThroughUnion({ oneOf: [pet, { type: 'null' }] })).toBe(true);
      expect(conjoinsObjectMember({ oneOf: [pet] })).toBe(true);
      expect(conjoinsObjectMember(pet)).toBe(false);
      expect(conjoinsObjectMember({ oneOf: [{ type: 'string' }] })).toBe(false);
    });

    it('`readInlineAllOf` reads such a member as it reads the `$ref`, wherever several members type the `allOf`', () => {
      const u = (reference: SchemaObject, keyword: 'oneOf' | 'anyOf' = 'oneOf'): SchemaObject => ({
        [keyword]: [reference],
      });
      const n = (reference: SchemaObject): SchemaObject => ({ oneOf: [reference, { type: 'null' }] });
      const schemas = components as Record<string, SchemaObject>;
      const reading = (members: SchemaObject[], wrapper: SchemaObject = {}) =>
        readInlineAllOf(members, { ...wrapper, allOf: members }, schemas);
      const merged: Array<[string, SchemaObject[], SchemaObject?]> = [
        ['two unions of one', [u(pet), u(owner)]],
        ['an anyOf of one beside a oneOf of one', [u(pet, 'anyOf'), u(owner)]],
        ['a union of one beside a `$ref`', [u(pet), owner]],
        ['a `$ref` beside a union of one', [owner, u(pet)]],
        ['two nullable wrappers', [n(pet), n(owner)]],
        ['a nullable wrapper beside a `$ref`', [n(pet), owner]],
        ['the OAS 3.0 flag beside a `$ref`', [{ oneOf: [pet], nullable: true }, owner]],
        ['three members', [u(pet), u(owner), u(ref('Shelter') as SchemaObject)]],
        ['a union of one around a union of one', [{ oneOf: [u(pet, 'anyOf')] }, owner]],
        ['an `allOf` around the union', [{ additionalProperties: false, allOf: [u(pet)] }, owner]],
        ['an `allOf` under the union', [{ oneOf: [{ allOf: [pet] }] }, owner]],
        ['both keywords on one member', [{ oneOf: [pet], anyOf: [ref('Toy') as SchemaObject] }, owner]],
        ['beside an object that declares nothing', [u(pet), { type: 'object' }]],
        ['beside a primitive', [u(pet), { type: 'string' }]],
        ['a `required` list beside a lone union of one', [u(pet)], { required: ['name'] }],
        ['a `required` list beside a lone nullable wrapper', [n(pet)], { required: ['name'] }],
        ['a member’s `required` list beside the union', [u(pet), { required: ['name'] }]],
      ];
      for (const [label, members, wrapper] of merged) {
        expect(reading(members, wrapper), label).toBe('merged');
        expect(classifyInlineSchema({ ...wrapper, allOf: members }), label).toBe('allOf');
      }
      // Alone, or beside members that only annotate or limit it, it is the member the `allOf` is read as.
      const unwrapped: Array<[string, SchemaObject[], SchemaObject?]> = [
        ['a lone union of one', [u(pet)]],
        ['a lone nullable wrapper', [n(pet)]],
        ['beside a description', [u(pet), { description: 'The pet.' }]],
        ['a nullable wrapper beside a description (#555)', [n(pet), { description: 'The pet.' }]],
        ['beside a limit', [u(pet), { minProperties: 1 }]],
        // `required` constrains an object: beside a union of one `$ref` to an array it adds nothing.
        [
          'a `required` list beside a union of one array',
          [u({ $ref: '#/components/schemas/Names' })],
          { required: ['name'] },
        ],
      ];
      for (const [label, members, wrapper] of unwrapped) {
        expect(reading(members, wrapper), label).toBe('unwrapped');
        expect(classifyInlineSchema({ ...wrapper, allOf: members }), label).toBe('allOf');
      }
      // A `$ref` member with nothing beside it is the reference, as it was.
      expect(reading([pet])).toBe('reference');
      expect(reading([pet, { description: 'The pet.' }])).toBe('reference');
      // No union brings a component: two primitives are read as neither, as before.
      expect(classifyInlineSchema({ allOf: [{ oneOf: [str] }, { oneOf: [{ type: 'integer' }] }] })).not.toBe('allOf');
    });

    it('`besideUnionsCompose` and `classifyInlineSchema` agree: a `$ref` variant composes, however many the union holds', () => {
      const prims = [str, { type: 'integer' }] as SchemaObject[];
      const cases: Array<[SchemaObject, boolean]> = [
        [{ oneOf: [pet], anyOf: [owner] }, true],
        [{ anyOf: [owner], oneOf: [pet] }, true],
        [{ allOf: [{ description: 'A pick.' }], oneOf: [pet], anyOf: [owner] }, true],
        [{ oneOf: [pet, { type: 'null' }], anyOf: [owner, { type: 'null' }] }, true],
        [{ oneOf: [pet], anyOf: [owner], nullable: true }, true],
        [{ oneOf: [pet], anyOf: prims }, true],
        [{ oneOf: prims, anyOf: [owner] }, true],
        [{ oneOf: [{ oneOf: [pet] }], anyOf: [{ anyOf: [owner] }] }, true],
        // No `$ref` and no properties: two unions that compose no object, as before (#680).
        [{ oneOf: prims, anyOf: prims }, false],
        [{ oneOf: [str], anyOf: [{ type: 'integer' }] }, false],
        [{ oneOf: [{ type: 'array', items: pet }], anyOf: [{ type: 'array', items: owner }] }, false],
        // One union alone, or beside one of bare limits (#613).
        [{ oneOf: [pet] }, false],
        [{ oneOf: [pet], anyOf: [{ required: ['name'] }] }, false],
      ];
      for (const [schema, composes] of cases) {
        expect(besideUnionsCompose(schema), JSON.stringify(schema)).toBe(composes);
        expect(classifyInlineSchema(schema) === 'allOf', JSON.stringify(schema)).toBe(composes);
      }
    });
  });

  describe('how the member is written', () => {
    const spelled: Array<[string, () => unknown, string[]]> = [
      ['a oneOf of one, twice', () => ({ allOf: [one('Pet'), one('Owner')] }), nameOwner],
      ['an anyOf of one, twice', () => ({ allOf: [one('Pet', 'anyOf'), one('Owner', 'anyOf')] }), nameOwner],
      ['a oneOf of one beside an anyOf of one', () => ({ allOf: [one('Pet'), one('Owner', 'anyOf')] }), nameOwner],
      ['a union of one beside a `$ref`', () => ({ allOf: [one('Pet'), ref('Owner')] }), nameOwner],
      ['an anyOf of one beside a `$ref`', () => ({ allOf: [one('Pet', 'anyOf'), ref('Owner')] }), nameOwner],
      ['a nullable wrapper beside a `$ref`', () => ({ allOf: [nul('Pet'), ref('Owner')] }), nameOwner],
      ['a nullable anyOf beside a `$ref`', () => ({ allOf: [nul('Pet', 'anyOf'), ref('Owner')] }), nameOwner],
      ['a nullable wrapper beside a union of one', () => ({ allOf: [nul('Pet'), one('Owner')] }), nameOwner],
      [
        'OAS 3.0 `nullable: true` beside the union of one',
        () => ({ allOf: [flagged('Pet'), ref('Owner')] }),
        nameOwner,
      ],
      ['wrapped once more', () => ({ allOf: [{ allOf: [one('Pet')] }, ref('Owner')] }), nameOwner],
      ['both wrapped once more', () => ({ allOf: [{ allOf: [one('Pet')] }, { allOf: [one('Owner')] }] }), nameOwner],
      ['wrapped twice', () => ({ allOf: [{ allOf: [{ allOf: [one('Pet')] }] }, ref('Owner')] }), nameOwner],
      [
        'typed `object` beside its union',
        () => ({
          allOf: [
            { type: 'object', ...one('Pet') },
            { type: 'object', ...one('Owner') },
          ],
        }),
        nameOwner,
      ],
      [
        'after a member that only annotates',
        () => ({ allOf: [{ description: 'Both.' }, one('Pet'), ref('Owner')] }),
        nameOwner,
      ],
      ['the same component twice', () => ({ allOf: [one('Pet'), one('Pet')] }), ['name?: string']],
      ['beside a `$ref` to the same component', () => ({ allOf: [one('Pet'), ref('Pet')] }), ['name?: string']],
      [
        'wrapped in an `allOf` that says more',
        () => ({ allOf: [{ additionalProperties: false, allOf: [one('Pet')] }, ref('Owner')] }),
        nameOwner,
      ],
      [
        'wrapped in an `allOf` typed `object`',
        () => ({ allOf: [{ type: 'object', allOf: [one('Pet')] }, ref('Owner')] }),
        nameOwner,
      ],
      [
        'a union of one around a union of one',
        () => ({ allOf: [{ oneOf: [one('Pet', 'anyOf')] }, ref('Owner')] }),
        nameOwner,
      ],
      [
        'a union of one around a nullable wrapper',
        () => ({ allOf: [{ oneOf: [nul('Pet')] }, ref('Owner')] }),
        nameOwner,
      ],
      [
        'an `allOf` under the union',
        () => ({ allOf: [{ oneOf: [{ allOf: [ref('Pet')] }] }, ref('Owner')] }),
        nameOwner,
      ],
      [
        'an `allOf` of two under a nullable wrapper',
        () => ({ allOf: [{ oneOf: [{ allOf: [ref('Pet'), ref('Toy')] }, nullVariant] }, ref('Owner')] }),
        ['name?: string', 'toy?: string', 'ownerId?: string'],
      ],
      [
        'both keywords on one member',
        () => ({ allOf: [{ oneOf: [ref('Pet')], anyOf: [ref('Toy')] }, ref('Owner')] }),
        ['name?: string', 'toy?: string', 'ownerId?: string'],
      ],
      [
        'both keywords on a lone member',
        () => ({ allOf: [{ oneOf: [ref('Pet')], anyOf: [ref('Toy')] }] }),
        ['name?: string', 'toy?: string'],
      ],
    ];

    it.each(spelled)('%s: the schema inline is the model the component is', async (label, schema, fields) => {
      const { reading } = await expectTwins(schema(), fields, label);
      expect(reading.field).toBe('HolderField');
      expect(reading.named).toBe('Comp');
    });

    it('the members in either order, and three of them', async () => {
      await expectTwins({ allOf: [ref('Owner'), one('Pet')] }, ['ownerId?: string', 'name?: string'], 'swapped');
      await expectTwins({ allOf: [one('Owner'), one('Pet')] }, ['ownerId?: string', 'name?: string'], 'both swapped');
      const three = ['name?: string', 'ownerId?: string', 'shelterId?: string'];
      await expectTwins({ allOf: [one('Pet'), one('Owner'), one('Shelter')] }, three, 'three unions of one');
      await expectTwins({ allOf: [ref('Pet'), one('Owner'), ref('Shelter')] }, three, 'between two `$ref`s');
      await expectTwins({ allOf: [one('Pet'), ref('Owner'), nul('Shelter')] }, three, 'one of each');
    });

    it('the components in either order', async () => {
      const schema = { allOf: [one('Pet'), one('Owner')] };
      const forward = twins(schema);
      const reversed = twins(schema);
      reversed.components.schemas = Object.fromEntries(Object.entries(reversed.components.schemas).reverse());
      const a = await read(forward);
      const b = await read(reversed);
      expect(twinReading(a.spec)).toEqual(twinReading(b.spec));
      expect(b.warnings).toEqual([]);
    });

    it('what a union of one flattens is optional, what a nullable wrapper applies is the component’s: both readers alike', async () => {
      // The two merge readers read each as they always did (`declareVariant`, `nullableAxisBranch`); the fix
      // is that the inline `allOf` is read as a merge at all.
      const requiring = {
        Pet: object({ name: str }, ['name']),
        Owner: object({ ownerId: str }, ['ownerId']),
      };
      const rows: Array<[string, unknown, string[], string[] | undefined]> = [
        ['two unions of one', { allOf: [one('Pet'), one('Owner')] }, nameOwner, undefined],
        [
          'a union of one beside a `$ref`',
          { allOf: [one('Pet'), ref('Owner')] },
          ['name?: string', 'ownerId: string'],
          ['Owner'],
        ],
        ['two `$ref`s', { allOf: [ref('Pet'), ref('Owner')] }, ['name: string', 'ownerId: string'], ['Pet', 'Owner']],
        [
          'a nullable wrapper beside a `$ref`',
          { allOf: [nul('Pet'), ref('Owner')] },
          ['name: string', 'ownerId: string'],
          ['Pet', 'Owner'],
        ],
        [
          'two nullable wrappers',
          { allOf: [nul('Pet'), nul('Owner')] },
          ['name: string', 'ownerId: string'],
          ['Pet', 'Owner'],
        ],
      ];
      for (const [label, schema, fields, bases] of rows) {
        const { spec } = await expectTwins(schema, fields, label, requiring);
        expect(basesOf(model(spec, 'Comp')), label).toEqual(bases);
      }
    });
  });

  describe('what the `$ref` names', () => {
    const extra: Record<string, Doc> = {
      PetAlias: ref('Pet'),
      Puppy: { allOf: [ref('Pet'), object({ breed: str }, ['breed'])] },
      PetOrToy: { oneOf: [ref('Pet'), ref('Toy')] },
      MaybePet: { oneOf: [ref('Pet'), nullVariant] },
      Names: { type: 'array', items: str },
      Color: { type: 'string', enum: ['red', 'blue'] },
      StringId: { type: 'string' },
      IntId: { type: 'integer' },
      Described: { description: 'Any.' },
      Nest: object({ meta: object({ x: str }) }),
    };
    const named: Array<[string, () => unknown, string[]]> = [
      ['an alias of the component', () => ({ allOf: [one('PetAlias'), ref('Owner')] }), nameOwner],
      [
        'a component its `allOf` composes',
        () => ({ allOf: [one('Puppy'), ref('Owner')] }),
        ['name?: string', 'breed?: string', 'ownerId?: string'],
      ],
      [
        'a named union',
        () => ({ allOf: [one('PetOrToy'), ref('Owner')] }),
        ['name?: string', 'toy?: string', 'ownerId?: string'],
      ],
      ['a nullable alias', () => ({ allOf: [one('MaybePet'), ref('Owner')] }), nameOwner],
      // No properties to bring: the merge still carries the other member's, as it does beside the `$ref` itself.
      ['an array component', () => ({ allOf: [one('Names'), ref('Owner')] }), ['ownerId?: string']],
      ['an enum component', () => ({ allOf: [one('Color'), ref('Owner')] }), ['ownerId?: string']],
      ['a primitive component', () => ({ allOf: [one('StringId'), ref('Owner')] }), ['ownerId?: string']],
      [
        'a component of nothing but a description',
        () => ({ allOf: [one('Described'), ref('Owner')] }),
        ['ownerId?: string'],
      ],
      ['two primitive components', () => ({ allOf: [one('StringId'), one('IntId')] }), []],
      [
        'a pointer into a component',
        () => ({ allOf: [{ oneOf: [{ $ref: '#/components/schemas/Nest/properties/meta' }] }, ref('Owner')] }),
        ['x?: string', 'ownerId?: string'],
      ],
    ];

    it.each(named)('%s: read as the same member around the `$ref` itself is weighed', async (label, schema, fields) => {
      await expectTwins(schema(), fields, label, extra);
    });

    it('is weighed as the `$ref` in its place is: a merge wherever two `$ref` members are one', async () => {
      // Whatever the component is, `allOf: [{ oneOf: [{ $ref: X }] }, { $ref: Owner }]` is a merge exactly as
      // `allOf: [{ $ref: X }, { $ref: Owner }]` is.
      for (const name of [
        'Pet',
        'PetAlias',
        'Puppy',
        'PetOrToy',
        'MaybePet',
        'Names',
        'Color',
        'StringId',
        'Described',
      ]) {
        const union = await read(twins({ allOf: [one(name), ref('Owner')] }, extra));
        const plain = await read(twins({ allOf: [ref(name), ref('Owner')] }, extra));
        expect(twinReading(union.spec).field, name).toBe('HolderField');
        expect(twinReading(plain.spec).field, name).toBe('HolderField');
        expect(modelNames(union.spec), name).toEqual(modelNames(plain.spec));
        expect(union.warnings, name).toEqual([]);
      }
    });

    it('a nested object the component declares is built under the merged model’s name, as a flattened variant’s is', async () => {
      const { spec, warnings } = await read(twins({ allOf: [one('Nest'), ref('Owner')] }, extra));
      expect(fieldsOf(model(spec, 'Comp'))).toEqual(['meta?: CompMeta', 'ownerId?: string']);
      expect(fieldsOf(model(spec, 'HolderField'))).toEqual(['meta?: HolderFieldMeta', 'ownerId?: string']);
      expect(fieldsOf(model(spec, 'HolderFieldMeta'))).toEqual(['x?: string']);
      expect(warnings).toEqual([]);
    });

    it('the component the schema is written in: the merge ends where it meets itself', async () => {
      const { spec, warnings } = await read(
        doc({
          Node: object({ id: str, next: { allOf: [one('Node'), one('Owner')] } }),
          Loop: { allOf: [one('Loop'), object({ id: str })] },
        }),
      );
      expect(fieldsOf(model(spec, 'Node'))).toEqual(['id?: string', 'next?: NodeNext']);
      expect(fieldsOf(model(spec, 'NodeNext'))).toEqual(['id?: string', 'next?: NodeNext', 'ownerId?: string']);
      expect(fieldsOf(model(spec, 'Loop'))).toEqual(['id?: string']);
      expect(warnings).toEqual([]);
    });

    it('a `$ref` no component answers fails the parse, as it does as a `$ref` member', async () => {
      for (const member of [one('Missing'), ref('Missing')]) {
        await expect(read(twins({ allOf: [member, ref('Owner')] }))).rejects.toThrow(/Can't resolve \$ref/);
      }
    });

    it('a `$ref` no component answers, which only `transformSpec` can write, is weighed as the `$ref` member is', async () => {
      const missing = () => ({ $ref: '#/components/schemas/Missing' });
      const parsed = async (schema: (reference: unknown) => unknown) => {
        warn.mockClear();
        const spec = await parseSpec(await write(twins({})), {
          transformSpec: (document) => {
            const { schemas } = document.components as { schemas: Record<string, { properties: Doc }> };
            (schemas as Record<string, unknown>).Comp = schema(missing());
            schemas.Holder!.properties.field = schema(missing());
            return document;
          },
        });
        return { spec, warnings: warn.mock.calls.map((call: unknown[]) => String(call[0])) };
      };
      // It contributes nothing to the merge, and the merge is made all the same.
      const merged = {
        component: ['ownerId?: string'],
        named: 'Comp',
        field: 'HolderField',
        inline: ['ownerId?: string'],
      };
      const members: Array<(reference: unknown) => unknown> = [
        (m) => ({ allOf: [{ oneOf: [m] }, ref('Owner')] }),
        (m) => ({ allOf: [m, ref('Owner')] }),
        (m) => ({ allOf: [{ oneOf: [m] }, one('Owner')] }),
        (m) => ({ oneOf: [m], anyOf: [ref('Owner')] }),
      ];
      for (const schema of members) {
        const { spec, warnings } = await parsed(schema);
        expect(twinReading(spec)).toEqual(merged);
        expect(warnings).toEqual([]);
      }
      // Alone beside a `required` list it declares no properties the list could add to: the member stands.
      const fieldOf = (spec: ApiSpec) => fieldsOf(model(spec, 'Holder'))[0];
      expect(fieldOf((await parsed((m) => ({ allOf: [{ oneOf: [m] }], required: ['name'] }))).spec)).toBe(
        'field?: (Missing)',
      );
      expect(fieldOf((await parsed((m) => ({ allOf: [m], required: ['name'] }))).spec)).toBe('field?: Missing');
    });
  });

  describe('beside what', () => {
    it('written beside the `allOf` instead of in it, the union of one is one more member (#398)', async () => {
      // A union beside an `allOf` that types the schema is its last member (`foldSiblingUnions`), so the
      // weighing is the same one: the base read each of these inline as the reference to `Base`.
      const idName = ['id: string', 'name?: string'];
      await expectTwins({ allOf: [ref('Base')], oneOf: [ref('Pet')] }, idName, 'a oneOf of one');
      await expectTwins({ allOf: [ref('Base')], anyOf: [ref('Pet')] }, idName, 'an anyOf of one');
      await expectTwins({ allOf: [ref('Base')], oneOf: [ref('Pet'), nullVariant] }, idName, 'a nullable wrapper');
      await expectTwins({ allOf: [ref('Base')], oneOf: [ref('Pet')], nullable: true }, idName, 'the OAS 3.0 flag');
      await expectTwins(
        { allOf: [ref('Base')], oneOf: [ref('Pet')], anyOf: [ref('Owner')] },
        [...idName, 'ownerId?: string'],
        'both keywords',
      );
    });

    it('what is written beside an `allOf` of such members is read as beside two `$ref` members', async () => {
      await expectTwins(
        { properties: { id: str }, allOf: [one('Pet'), one('Owner')] },
        ['id?: string', ...nameOwner],
        '`properties`',
      );
      // The base read the field as a map of `unknown`, by its `type`.
      await expectTwins({ type: 'object', allOf: [one('Pet'), one('Owner')] }, nameOwner, '`type: object`');
      await expectTwins({ type: ['object', 'string'], allOf: [one('Pet'), one('Owner')] }, nameOwner, 'a type list');
      const nullable = openapi === '3.0.3' ? { type: 'object', nullable: true } : { type: ['object', 'null'] };
      const { reading } = await expectTwins({ ...nullable, allOf: [one('Pet'), one('Owner')] }, nameOwner, 'nullable');
      expect(reading.field).toBe('nullable<HolderField>');
      // A nullable wrapper beside the `allOf` is one more member: its variant applies, and the unions of
      // one admit no `null` (the base read the `oneOf` alone: `nullable<Base>`, the `allOf` unread).
      await expectTwins(
        { allOf: [one('Pet'), one('Owner')], oneOf: [ref('Base'), nullVariant] },
        [...nameOwner, 'id: string'],
        'a nullable wrapper beside',
      );
      await expectTwins(
        { description: 'Both.', deprecated: true, allOf: [one('Pet'), one('Owner')] },
        nameOwner,
        'text',
      );
      // A primitive `type` too: the `allOf` types the schema, as two `$ref` members do (the base read the
      // `string` its `type` says, the `allOf` unread).
      const typed = (members: unknown[]) => twins({ type: 'string', allOf: members });
      const unions = await read(typed([one('Pet'), one('Owner')]));
      const refs = await read(typed([ref('Pet'), ref('Owner')]));
      expect(twinReading(unions.spec)).toMatchObject({ component: nameOwner, inline: nameOwner, field: 'HolderField' });
      expect(modelNames(unions.spec)).toEqual(modelNames(refs.spec));
    });

    it('a union written beside an `allOf` of such members is one more member, not the schema’s one union', async () => {
      const Cat = object({ kind: pinned('cat'), meow: str }, ['kind']);
      const Dog = object({ kind: pinned('dog'), bark: str }, ['kind']);
      const schema = { allOf: [one('Pet'), one('Owner')], oneOf: [ref('Cat'), ref('Dog')] };
      const { spec, warnings } = await read(twins(schema, { Cat, Dog }));
      // The base read both twins as the union of `Cat` and `Dog`, the `allOf` unread.
      expect(describeModel(model(spec, 'Comp'))).toBe(
        'Comp { name?: string, ownerId?: string } by kind {"cat":"Cat","dog":"Dog"}',
      );
      // An inline `allOf` never dispatches: the union is flattened beside the two.
      expect(fieldsOf(model(spec, 'HolderField')).map((field) => field.split(':')[0])).toEqual([
        'name?',
        'ownerId?',
        'kind?',
        'meow?',
        'bark?',
      ]);
      expect(warnings).toEqual([]);
      // As with two `$ref` members in the `allOf`'s place.
      const plain = await read(
        twins({ allOf: [ref('Pet'), ref('Owner')], oneOf: [ref('Cat'), ref('Dog')] }, { Cat, Dog }),
      );
      expect(model(plain.spec, 'Comp').discriminator).toEqual(model(spec, 'Comp').discriminator);
      expect(fieldsOf(model(plain.spec, 'HolderField'))).toEqual(fieldsOf(model(spec, 'HolderField')));
    });

    it('a variant of a named union: the variant model is built', async () => {
      const { spec, warnings } = await read(
        doc({
          Shape: { oneOf: [{ allOf: [one('Pet'), one('Owner')] }, ref('Toy')] },
          Holder: object({ shape: ref('Shape') }),
        }),
      );
      // The base read the variant as `unknown`, with a warning.
      expect(model(spec, 'Shape').variants?.map(show)).toEqual(['ShapeVariant1', 'Toy']);
      expect(fieldsOf(model(spec, 'ShapeVariant1'))).toEqual(nameOwner);
      expect(warnings).toEqual([]);
    });

    it('an inline object, an object that declares nothing, a primitive: the merge the component is', async () => {
      await expectTwins({ allOf: [one('Pet'), object({ extra: str })] }, ['name?: string', 'extra?: string'], 'object');
      await expectTwins({ allOf: [one('Pet'), { type: 'object' }] }, ['name?: string'], '`type: object`');
      // The base read the next two as no reading at all: `unknown`, with a warning.
      await expectTwins({ allOf: [one('Pet'), str] }, ['name?: string'], 'a primitive');
      await expectTwins({ allOf: [nul('Pet'), { type: 'array', items: str }] }, ['name?: string'], 'an array');
    });

    it('a `required` list adds to it as it adds to the `$ref`: when the component declares properties', async () => {
      const extra = { Names: { type: 'array', items: str } };
      await expectTwins({ allOf: [one('Pet')], required: ['name'] }, ['name: string'], 'the schema’s own');
      await expectTwins({ allOf: [one('Pet'), { required: ['name'] }] }, ['name: string'], 'a member’s');
      await expectTwins({ allOf: [{ allOf: [one('Pet')] }], required: ['name'] }, ['name: string'], 'wrapped');
      const { reading } = await expectTwins({ allOf: [nul('Pet')], required: ['name'] }, ['name: string'], 'nullable');
      expect(reading.field).toBe('nullable<HolderField>');
      // Beside a union of one array `required` constrains nothing: the member is the schema, as before.
      const { spec, warnings } = await read(twins({ allOf: [one('Names')], required: ['name'] }, extra));
      expect(twinReading(spec).field).toBe('(string[])');
      expect(warnings).toEqual([]);
    });

    it('alone, or beside members that only annotate or limit it, it is still the member the `allOf` is read as', async () => {
      const rows: Array<[string, unknown, string]> = [
        ['a lone union of one', { allOf: [one('Pet')] }, '(Pet)'],
        ['the union of one itself', one('Pet'), '(Pet)'],
        ['beside a description', { allOf: [one('Pet'), { description: 'The pet.' }] }, '(Pet)'],
        ['beside a limit', { allOf: [one('Pet'), { minProperties: 1 }] }, '(Pet)'],
        ['a lone nullable wrapper', { allOf: [nul('Pet')] }, 'nullable<Pet>'],
        [
          'a nullable wrapper beside a description (#555)',
          { allOf: [nul('Pet'), { description: 'The pet.' }] },
          'nullable<Pet>',
        ],
        [
          'the flag beside a description (#555)',
          { allOf: [flagged('Pet'), { description: 'The pet.' }] },
          'nullable<Pet>',
        ],
        ['a lone `$ref`', { allOf: [ref('Pet')] }, 'Pet'],
        ['a `$ref` beside a description', { allOf: [ref('Pet'), { description: 'The pet.' }] }, 'Pet'],
      ];
      for (const [label, schema, type] of rows) {
        const { spec, warnings } = await read(doc({ Holder: object({ field: schema }) }));
        expect(fieldsOf(model(spec, 'Holder')), label).toEqual([`field?: ${type}`]);
        expect(modelNames(spec), label).not.toContain('HolderField');
        expect(warnings, label).toEqual([]);
      }
    });
  });

  describe('null', () => {
    const nullable: Record<string, Doc> = {
      NullablePet: nullableObject({ name: str }),
      NullableOwner: nullableObject({ ownerId: str }),
    };

    it('the merge admits `null` exactly when every member that types it does (#676, #715): one vote for both twins', async () => {
      const rows: Array<[string, unknown, boolean]> = [
        ['two nullable wrappers', { allOf: [nul('Pet'), nul('Owner')] }, true],
        ['two flagged unions of one', { allOf: [flagged('Pet'), flagged('Owner')] }, true],
        [
          'a nullable wrapper beside a member with no vote',
          { allOf: [nul('Pet'), nul('Owner'), { description: 'Both.' }] },
          true,
        ],
        ['a nullable wrapper beside a `$ref` that admits none', { allOf: [nul('Pet'), ref('Owner')] }, false],
        ['a nullable wrapper beside a union of one', { allOf: [nul('Pet'), one('Owner')] }, false],
        ['two unions of one', { allOf: [one('Pet'), one('Owner')] }, false],
        // A union votes as the union the type builder types it as: by the `null` it writes, whatever its
        // variants name (`nullVote`).
        ['two unions of one nullable component', { allOf: [one('NullablePet'), one('NullableOwner')] }, false],
        ['two `$ref`s to nullable components', { allOf: [ref('NullablePet'), ref('NullableOwner')] }, true],
      ];
      for (const [label, schema, admits] of rows) {
        const { reading } = await expectTwins(schema, nameOwner, label, nullable);
        expect(reading.field, label).toBe(admits ? 'nullable<HolderField>' : 'HolderField');
        expect(reading.named, label).toBe(admits ? 'nullable<Comp>' : 'Comp');
      }
    });
  });

  describe('every site', () => {
    const op = (operationId: string, extra: Doc = {}, response: unknown = ref('Base')) => ({
      operationId,
      responses: { '200': okBody(response) },
      ...extra,
    });
    const sites: Array<[string, (s: unknown) => unknown]> = [
      ['a component and a `$ref` to it', (s) => doc({ Pick: s, Holder: object({ pick: ref('Pick') }) })],
      ['a field', (s) => doc({ Holder: object({ pick: s }) })],
      ['an array’s items', (s) => doc({ Holder: object({ picks: { type: 'array', items: s } }) })],
      ['a map’s values', (s) => doc({ Holder: object({ picks: { type: 'object', additionalProperties: s } }) })],
      ['a variant of another union', (s) => doc({ Holder: object({ pick: { oneOf: [s, { type: 'boolean' }] } }) })],
      ['under a nullable wrapper', (s) => doc({ Holder: object({ pick: { oneOf: [s, nullVariant] } }) })],
      ['a lone `allOf` member', (s) => doc({ Holder: object({ pick: { allOf: [s] } }) })],
      [
        'an array component’s items',
        (s) => doc({ Picks: { type: 'array', items: s } }, { '/picks': { get: op('listPicks', {}, ref('Picks')) } }),
      ],
      [
        'a query parameter',
        (s) =>
          doc({}, { '/picks': { get: op('listPicks', { parameters: [{ name: 'pick', in: 'query', schema: s }] }) } }),
      ],
      [
        'a response header',
        (s) =>
          doc(
            {},
            {
              '/picks': {
                get: {
                  operationId: 'getPick',
                  responses: { '200': { ...okBody(ref('Base')), headers: { 'X-Pick': { schema: s } } } },
                },
              },
            },
          ),
      ],
      [
        'a request body',
        (s) => doc({}, { '/picks': { post: op('createPick', { requestBody: { required: true, content: json(s) } }) } }),
      ],
      [
        'a field of a request body',
        (s) =>
          doc({}, { '/picks': { post: op('createPick', { requestBody: { content: json(object({ pick: s })) } }) } }),
      ],
      ['a response body', (s) => doc({}, { '/picks': { get: op('getPick', {}, s) } })],
      [
        'the items of a response body',
        (s) => doc({}, { '/picks': { get: op('listPicks', {}, { type: 'array', items: s }) } }),
      ],
      [
        'an error body',
        (s) =>
          doc(
            {},
            {
              '/picks': {
                get: {
                  operationId: 'getPick',
                  responses: { '200': okBody(ref('Base')), '400': { description: 'Bad', content: json(s) } },
                },
              },
            },
          ),
      ],
      [
        'a callback body',
        (s) =>
          doc(
            {},
            {
              '/picks': {
                post: op('createPick', {
                  callbacks: {
                    onPick: {
                      '{$request.body#/url}': {
                        post: { requestBody: { content: json(s) }, responses: { '200': { description: 'OK' } } },
                      },
                    },
                  },
                }),
              },
            },
          ),
      ],
    ];
    if (openapi !== '3.0.3') {
      sites.push([
        'a webhook payload',
        (s) =>
          doc(
            {},
            {},
            {
              webhooks: {
                picked: {
                  post: {
                    operationId: 'onPicked',
                    requestBody: { content: json(s) },
                    responses: { '200': { description: 'OK' } },
                  },
                },
              },
            },
          ),
      ]);
    }
    /** The issue's three schemas, each beside the spelling the base already merged: a second variant in one union. */
    const shapes: Array<[string, unknown, string[]]> = [
      ['`Both`', { allOf: [one('Pet'), one('Owner')] }, nameOwner],
      ['`Mixed`', { allOf: [one('Pet'), ref('Owner')] }, nameOwner],
      ['`Pick`', { description: 'A pick.', oneOf: [ref('Pet')], anyOf: [ref('Owner')] }, nameOwner],
      ['two nullable wrappers', { allOf: [nul('Pet'), nul('Owner')] }, nameOwner],
    ];
    /** The models a document mints beyond its components and `Holder`. */
    const minted = (spec: ApiSpec) => spec.models.filter((m) => !known.has(m.name));

    it.each(sites)('%s: one model of `name` and `ownerId`, no warning, nothing `unknown`', async (site, where) => {
      for (const [shape, schema, fields] of shapes) {
        const label = `${shape} at ${site}`;
        const { spec, warnings } = await read(where(structuredClone(schema)));
        const models = minted(spec).filter((m) => fieldsOf(m).join() === fields.join());
        expect(
          models.map((m) => m.name),
          label,
        ).toHaveLength(1);
        expect(models[0]!.variants, label).toBeUndefined();
        expect(warnings, label).toEqual([]);
        expect(JSON.stringify(spec), label).not.toContain('"unknown"');
        // The same schema with two `$ref` members names the same model at the same place.
        const plain = await read(where({ allOf: [ref('Pet'), ref('Owner')] }));
        expect(modelNames(spec), label).toEqual(modelNames(plain.spec));
      }
    });

    it('names the model each site names', async () => {
      const both = { allOf: [one('Pet'), one('Owner')] };
      const readings: string[] = [];
      for (const [site, where] of sites) {
        if (site === 'a webhook payload') continue;
        const { spec } = await read(where(structuredClone(both)));
        readings.push(`${site}: ${minted(spec).map(describeModel).join('; ')}`);
      }
      expect(readings).toMatchInlineSnapshot(`
        [
          "a component and a \`$ref\` to it: Pick { name?: string, ownerId?: string }",
          "a field: HolderPick { name?: string, ownerId?: string }",
          "an array’s items: HolderPick { name?: string, ownerId?: string }",
          "a map’s values: HolderPick { name?: string, ownerId?: string }",
          "a variant of another union: HolderPick { name?: string, ownerId?: string }",
          "under a nullable wrapper: HolderPick { name?: string, ownerId?: string }",
          "a lone \`allOf\` member: HolderPick { name?: string, ownerId?: string }",
          "an array component’s items: PickItem { name?: string, ownerId?: string }",
          "a query parameter: PicksPick { name?: string, ownerId?: string }",
          "a response header: PicksXPick { name?: string, ownerId?: string }",
          "a request body: CreatePickRequest { name?: string, ownerId?: string }",
          "a field of a request body: CreatePickRequest { pick?: CreatePickRequestPick }; CreatePickRequestPick { name?: string, ownerId?: string }",
          "a response body: GetPickResponse { name?: string, ownerId?: string }",
          "the items of a response body: ListPicksItem { name?: string, ownerId?: string }",
          "an error body: OptionalErrorBodyWithNameOwnerIdWithoutMessage { name?: string, ownerId?: string }",
          "a callback body: CreatePickOnPickPayload { name?: string, ownerId?: string }",
        ]
      `);
    });

    it('types the site as the model, under whatever wraps it', async () => {
      const both = { allOf: [one('Pet'), one('Owner')] };
      const typed = async (index: number, type: (spec: ApiSpec) => TypeRef | undefined) =>
        show(type((await read(sites[index]![1](structuredClone(both)))).spec));
      const holderField = (name: string) => (spec: ApiSpec) =>
        model(spec, 'Holder').fields.find((f) => f.name === name)?.type;
      expect(await typed(0, holderField('pick'))).toBe('Pick');
      expect(await typed(1, holderField('pick'))).toBe('HolderPick');
      expect(await typed(2, holderField('picks'))).toBe('HolderPick[]');
      expect(await typed(3, holderField('picks'))).toBe('map<HolderPick>');
      expect(await typed(4, holderField('pick'))).toBe('(HolderPick | boolean)');
      expect(await typed(5, holderField('pick'))).toBe('nullable<HolderPick>');
      expect(await typed(6, holderField('pick'))).toBe('HolderPick');
      expect(await typed(8, (spec) => operation(spec, 'listPicks').queryParams[0]?.type)).toBe('PicksPick');
      expect(await typed(10, (spec) => operation(spec, 'createPick').requestBody)).toBe('CreatePickRequest');
      expect(await typed(12, (spec) => operation(spec, 'getPick').response)).toBe('GetPickResponse');
    });
  });

  describe('`Pick`: a oneOf of one `$ref` beside an anyOf', () => {
    const sited = (Pick: unknown, schemas: Record<string, unknown> = {}) =>
      doc({
        ...schemas,
        Pick,
        Named: object({ pick: ref('Pick') }),
        Holder: object({ pick: Pick }),
        Combo: { allOf: [ref('Base'), ref('Pick')] },
        Through: object({ merged: { allOf: [ref('Base'), ref('Pick')] } }),
      });
    /** The three spellings of one pair of unions: the description beside them, in an `allOf`, and each union a member. */
    const spellings = (unions: { oneOf: unknown[]; anyOf: unknown[] }, extra: Doc = {}) => ({
      plain: { description: 'A pick.', ...extra, ...unions },
      beside: { allOf: [{ description: 'A pick.' }], ...extra, ...unions },
      member: {
        description: 'A pick.',
        allOf: [
          { oneOf: unions.oneOf, ...extra },
          { anyOf: unions.anyOf, ...extra },
        ],
      },
    });

    const pairs: Array<[string, { oneOf: unknown[]; anyOf: unknown[] }, Doc, string[], boolean]> = [
      ['one `$ref` each', { oneOf: [ref('Pet')], anyOf: [ref('Owner')] }, {}, nameOwner, false],
      // The two the base already composed: pinned.
      [
        'one `$ref` beside two',
        { oneOf: [ref('Pet')], anyOf: [ref('Owner'), ref('Shelter')] },
        {},
        ['name?: string', 'ownerId?: string', 'shelterId?: string'],
        false,
      ],
      [
        'two beside one `$ref`',
        { oneOf: [ref('Pet'), ref('Toy')], anyOf: [ref('Owner')] },
        {},
        ['name?: string', 'toy?: string', 'ownerId?: string'],
        false,
      ],
      [
        'two nullable wrappers',
        { oneOf: [ref('Pet'), nullVariant], anyOf: [ref('Owner'), nullVariant] },
        {},
        nameOwner,
        true,
      ],
      [
        'a nullable wrapper beside one `$ref`',
        { oneOf: [ref('Pet'), nullVariant], anyOf: [ref('Owner')] },
        {},
        nameOwner,
        false,
      ],
      [
        'one `$ref` each beside OAS 3.0 `nullable: true`',
        { oneOf: [ref('Pet')], anyOf: [ref('Owner')] },
        { nullable: true },
        nameOwner,
        true,
      ],
    ];

    it.each(pairs)(
      '%s: the model at every site, in every spelling',
      async (label, unions, extra, fields, admitsNull) => {
        const { plain, beside, member } = spellings(unions, extra);
        expect(besideUnionsCompose(plain as SchemaObject)).toBe(true);
        expect(besideUnionsCompose(beside as SchemaObject)).toBe(true);
        const { spec, warnings } = await expectSameReading(sited(plain), sited(beside), label);
        await expectSameReading(sited(plain), sited(member), label);
        expect(warnings).toEqual([]);
        expect(fieldsOf(model(spec, 'Pick'))).toEqual(fields);
        expect(model(spec, 'Pick').variants).toBeUndefined();
        expect(fieldsOf(model(spec, 'HolderPick'))).toEqual(fields);
        expect(fieldsOf(model(spec, 'Holder'))).toEqual([
          admitsNull ? 'pick?: nullable<HolderPick>' : 'pick?: HolderPick',
        ]);
        expect(fieldsOf(model(spec, 'Named'))).toEqual([admitsNull ? 'pick?: nullable<Pick>' : 'pick?: Pick']);
        // A model naming the component carries what the component's own model does, the component its base.
        expect(fieldsOf(model(spec, 'Combo'))).toEqual(['id: string', ...fields]);
        expect(basesOf(model(spec, 'Combo'))).toEqual(['Base', 'Pick']);
        expect(fieldsOf(model(spec, 'ThroughMerged'))).toEqual(['id: string', ...fields]);
      },
    );

    it('either order of the two keywords', async () => {
      await expectSameReading(
        sited({ oneOf: [ref('Pet')], anyOf: [ref('Owner')] }),
        sited({ anyOf: [ref('Owner')], oneOf: [ref('Pet')] }),
      );
    });

    it('`oagen diff` between the spellings exits 0 in both directions, for one `$ref` each and for its mirror images', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      for (const [label, unions, extra] of pairs) {
        const { plain, beside } = spellings(unions, extra);
        const files = [await write(sited(plain)), await write(sited(beside))];
        for (const [from, to] of [files, [...files].reverse()]) {
          const error = (await diffCommand({ old: from!, new: to! }).catch((e: unknown) => e)) as { exitCode: number };
          expect(error.exitCode, label).toBe(0);
        }
      }
    });

    it('`oagen diff` from the union of the `oneOf` to the model reports the reading that changed', async () => {
      // What the base read `Pick` as is what the `oneOf` alone still is.
      const alone = await read(doc({ Pick: { description: 'A pick.', oneOf: [ref('Pet')] } }));
      const both = await read(doc({ Pick: { description: 'A pick.', oneOf: [ref('Pet')], anyOf: [ref('Owner')] } }));
      expect(model(alone.spec, 'Pick').variants?.map(show)).toEqual(['Pet']);
      expect(model(both.spec, 'Pick').variants).toBeUndefined();
      expect(
        diffSpecs(alone.spec, both.spec)
          .changes.map((change) => change.kind)
          .sort(),
      ).toMatchInlineSnapshot(`
        [
          "model-modified",
        ]
      `);
    });

    it('what the `$ref`s name: a `$ref` variant composes, as two `$ref` members do, whatever it names', async () => {
      const extra = { StringId: { type: 'string' }, IntId: { type: 'integer' }, Names: { type: 'array', items: str } };
      const rows: Array<[string, { oneOf: unknown[]; anyOf: unknown[] }, string[]]> = [
        [
          'an object beside a primitive component',
          { oneOf: [ref('Pet')], anyOf: [ref('StringId')] },
          ['name?: string'],
        ],
        ['an object beside an array component', { oneOf: [ref('Names')], anyOf: [ref('Owner')] }, ['ownerId?: string']],
        ['an object beside an inline primitive', { oneOf: [str], anyOf: [ref('Owner')] }, ['ownerId?: string']],
        ['two primitive components', { oneOf: [ref('StringId')], anyOf: [ref('IntId')] }, []],
      ];
      for (const [label, unions, fields] of rows) {
        const { plain, beside, member } = spellings(unions);
        const { spec, warnings } = await expectSameReading(sited(plain, extra), sited(beside, extra), label);
        await expectSameReading(sited(plain, extra), sited(member, extra), label);
        expect(fieldsOf(model(spec, 'Pick')), label).toEqual(fields);
        expect(fieldsOf(model(spec, 'HolderPick')), label).toEqual(fields);
        expect(warnings, label).toEqual([]);
        // Two unions of two such `$ref`s were read so already, and so are two `$ref` members.
        const members = await read(
          sited({ allOf: [...unions.oneOf, ...unions.anyOf].filter((v) => v !== str) }, extra),
        );
        expect(fieldsOf(model(members.spec, 'Pick')), label).toEqual(fields);
      }
    });

    it('two unions that bring no component are still not composed: the `oneOf` alone, the `anyOf` reported (#680)', async () => {
      const unread = (context: string) =>
        `[oagen] Warning: \`anyOf\` beside \`oneOf\` is not read: the two unions cannot both type the schema, which is typed by its \`oneOf\` alone (context: ${context})`;
      const rows: Array<[string, { oneOf: unknown[]; anyOf: unknown[] }, string]> = [
        ['one primitive each', { oneOf: [str], anyOf: [{ type: 'integer' }] }, '(string)'],
        [
          'one array each',
          { oneOf: [{ type: 'array', items: ref('Pet') }], anyOf: [{ type: 'array', items: ref('Owner') }] },
          '(Pet[])',
        ],
      ];
      for (const [label, unions, type] of rows) {
        const { spec, warnings } = await read(doc({ Pick: unions, Holder: object({ pick: unions }) }));
        expect(fieldsOf(model(spec, 'Holder')), label).toEqual([`pick?: ${type}`]);
        expect(warnings, label).toEqual([unread('Pick'), unread('Holder.pick')]);
      }
    });

    it('`properties` beside the two are the first member, at a field as on the component', async () => {
      const Pick = { properties: { id: str }, required: ['id'], oneOf: [ref('Pet')], anyOf: [ref('Owner')] };
      const { spec, warnings } = await read(doc({ Pick, Holder: object({ pick: Pick }) }));
      for (const name of ['Pick', 'HolderPick']) {
        expect(fieldsOf(model(spec, name)), name).toEqual(['id: string', ...nameOwner]);
      }
      // The base read the field as the union of one `(Pet)`, and reported the `anyOf`.
      expect(warnings).toEqual([]);
    });
  });

  describe('a discriminator (#718)', () => {
    const pets: Record<string, Doc> = {
      Cat: object({ kind: pinned('cat'), meow: str }, ['kind']),
      Dog: object({ kind: pinned('dog'), bark: str }, ['kind']),
    };
    const toCatDog = { cat: at('Cat'), dog: at('Dog') };
    const reads = (spec: ApiSpec, name: string) => describeModel(model(spec, name));

    it('goes with the union whose variants its `mapping` names: the union of one `$ref` is flattened', async () => {
      const discriminator = { propertyName: 'kind', mapping: toCatDog };
      const spelled: Array<[string, Doc]> = [
        ['beside the two unions', { oneOf: [ref('Pet')], anyOf: [ref('Cat'), ref('Dog')], discriminator }],
        ['the unions swapped', { oneOf: [ref('Cat'), ref('Dog')], anyOf: [ref('Pet')], discriminator }],
        ['beside the `allOf` of the two', { allOf: [one('Pet'), { anyOf: [ref('Cat'), ref('Dog')] }], discriminator }],
        ['on the member it names', { allOf: [one('Pet'), { anyOf: [ref('Cat'), ref('Dog')], discriminator }] }],
        ['on the union of one', { allOf: [{ ...one('Pet'), discriminator }, { anyOf: [ref('Cat'), ref('Dog')] }] }],
        [
          'with no `mapping`, the variants pinning the property',
          { oneOf: [ref('Pet')], anyOf: [ref('Cat'), ref('Dog')], discriminator: { propertyName: 'kind' } },
        ],
      ];
      for (const [label, Pick] of spelled) {
        const { spec, warnings } = await read(doc({ ...pets, Pick, Holder: object({ pick: Pick }) }));
        expect(reads(spec, 'Pick'), label).toBe('Pick { name?: string } by kind {"cat":"Cat","dog":"Dog"}');
        // An inline `allOf` never dispatches: both unions are flattened.
        expect(
          fieldsOf(model(spec, 'HolderPick')).map((field) => field.split(':')[0]),
          label,
        ).toEqual(
          label === 'the unions swapped' ? ['kind?', 'meow?', 'bark?', 'name?'] : ['name?', 'kind?', 'meow?', 'bark?'],
        );
        expect(warnings, label).toEqual([]);
      }
    });

    it('one `$ref` each: the two compose, and the keyword goes with the union its `mapping` names', async () => {
      // #718 pinned this pair as two unions that compose nothing, the keyword left with the `oneOf`.
      const Pick = {
        oneOf: [ref('Pet')],
        anyOf: [ref('Cat')],
        discriminator: { propertyName: 'kind', mapping: { cat: at('Cat') } },
      };
      const { spec, warnings } = await read(doc({ ...pets, Pick, Holder: object({ pick: Pick }) }));
      expect(reads(spec, 'Pick')).toBe('Pick { name?: string } by kind {"cat":"Cat"}');
      expect(fieldsOf(model(spec, 'HolderPick'))).toEqual(['name?: string', 'kind?: "cat"', 'meow?: string']);
      expect(warnings).toEqual([]);
      const mirrored = { ...Pick, oneOf: Pick.anyOf, anyOf: Pick.oneOf };
      const mirror = await read(doc({ ...pets, Pick: mirrored }));
      expect(reads(mirror.spec, 'Pick')).toBe('Pick { name?: string } by kind {"cat":"Cat"}');
    });
  });

  describe('two declarations of one property', () => {
    it('conjoin when one names a component through a union of one, as with two variants', async () => {
      // `owner` declared by two members of one `allOf`: the conjunction of the two declarations reads a
      // member that names a component through a union whatever the count of its variants.
      const holder = (first: unknown, second: unknown) =>
        doc({ Holder: { allOf: [object({ owner: first }), object({ owner: second })] } });
      const three = ['name?: string', 'ownerId?: string', 'label?: string'];
      const one1 = await read(holder({ allOf: [one('Pet'), ref('Owner')] }, ref('Tag')));
      expect(fieldsOf(model(one1.spec, 'Holder'))).toEqual(['owner?: HolderOwner']);
      // The base kept the first declaration and read it as the reference to `Owner`: `Pet` and `Tag` lost.
      expect(fieldsOf(model(one1.spec, 'HolderOwner'))).toEqual(three);
      const swapped = await read(holder(ref('Tag'), { allOf: [one('Pet'), ref('Owner')] }));
      expect(fieldsOf(model(swapped.spec, 'HolderOwner'))).toEqual([
        'label?: string',
        'name?: string',
        'ownerId?: string',
      ]);
      const two = await read(holder({ allOf: [{ oneOf: [ref('Pet'), ref('Toy')] }, ref('Owner')] }, ref('Tag')));
      expect(fieldsOf(model(two.spec, 'HolderOwner'))).toEqual([
        'name?: string',
        'toy?: string',
        'ownerId?: string',
        'label?: string',
      ]);
      for (const { warnings } of [one1, swapped, two]) expect(warnings).toEqual([]);
    });

    it('a union alone beside a `$ref` keeps the first declaration, whatever its count of variants: unchanged', async () => {
      const holder = (first: unknown, second: unknown) =>
        doc({ Holder: { allOf: [object({ owner: first }), object({ owner: second })] } });
      const rows: Array<[unknown, unknown, string]> = [
        [one('Pet'), ref('Tag'), '(Pet)'],
        [{ oneOf: [ref('Pet'), ref('Toy')] }, ref('Tag'), '(Pet | Toy)'],
        [ref('Tag'), one('Pet'), 'Tag'],
      ];
      for (const [first, second, type] of rows) {
        const { spec } = await read(holder(first, second));
        expect(fieldsOf(model(spec, 'Holder'))).toEqual([`owner?: ${type}`]);
      }
    });
  });

  describe('what was merged already', () => {
    it('a union of one inline object, a union of two or more variants, and two `$ref` members read as they did', async () => {
      const rows: Array<[string, unknown, string[]]> = [
        [
          'a union of one inline object beside a `$ref`',
          { allOf: [{ oneOf: [object({ a: str }, ['a'])] }, ref('Owner')] },
          ['a?: string', 'ownerId?: string'],
        ],
        [
          'two unions of one inline object',
          { allOf: [{ oneOf: [object({ a: str })] }, { anyOf: [object({ b: str })] }] },
          ['a?: string', 'b?: string'],
        ],
        [
          'a nullable wrapper around an inline object beside a `$ref`',
          { allOf: [{ oneOf: [object({ a: str }, ['a']), nullVariant] }, ref('Owner')] },
          ['a: string', 'ownerId?: string'],
        ],
        [
          'a union of two `$ref`s beside a `$ref`',
          { allOf: [{ oneOf: [ref('Pet'), ref('Toy')] }, ref('Owner')] },
          ['name?: string', 'toy?: string', 'ownerId?: string'],
        ],
        [
          'two unions of two `$ref`s',
          { allOf: [{ oneOf: [ref('Pet'), ref('Toy')] }, { anyOf: [ref('Owner'), ref('Shelter')] }] },
          ['name?: string', 'toy?: string', 'ownerId?: string', 'shelterId?: string'],
        ],
        ['two `$ref` members', { allOf: [ref('Pet'), ref('Owner')] }, nameOwner],
      ];
      for (const [label, schema, fields] of rows) await expectTwins(schema, fields, label);
    });
  });

  describe('the passes that follow the reading', () => {
    it('a JSON Pointer to the schema is the merged model', async () => {
      const { spec, warnings } = await read(
        doc({
          Holder: object({ both: { allOf: [one('Pet'), one('Owner')] } }),
          Named: object({ both: { $ref: '#/components/schemas/Holder/properties/both' } }),
        }),
      );
      expect(fieldsOf(model(spec, 'Named'))).toEqual(['both?: HolderBoth']);
      expect(fieldsOf(model(spec, 'HolderBoth'))).toEqual(nameOwner);
      expect(warnings).toEqual([]);
    });

    it('a response body: the merge at a body written inline, and the list envelope a flattened union gives', async () => {
      const paths = (body: unknown) => ({
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [{ name: 'after', in: 'query', schema: str }],
            responses: { '200': okBody(body) },
          },
        },
      });
      const schemas = {
        Data: object({ data: { type: 'array', items: ref('Pet') } }, ['data']),
        Meta: object({ has_more: { type: 'boolean' }, after: str }),
      };
      const list = ['data: Pet[]', 'has_more?: boolean', 'after?: string'];
      // Beside a `$ref` member the body is the model of both (it was `Data`, `Meta` dropped): a `$ref`
      // member's component is not read for an envelope, here as with two `$ref` members (#308).
      for (const body of [
        { allOf: [ref('Data'), one('Meta')] },
        { allOf: [ref('Data'), nul('Meta')] },
        { allOf: [ref('Data'), ref('Meta')] },
      ]) {
        const { spec, warnings } = await read(doc(schemas, paths(body)));
        expect(show(operation(spec, 'listPets').response)).toBe('ListPetsResponse');
        expect(fieldsOf(model(spec, 'ListPetsResponse'))).toEqual(list);
        expect(warnings).toEqual([]);
      }
      // Two unions of one are two flattened unions, read for an envelope as any union among the members of
      // a merge is (it was `unknown`, with a warning): the array its every variant declares, and the stop
      // field beside it.
      const both = await read(doc(schemas, paths({ allOf: [one('Data'), one('Meta')] })));
      const inline = await read(doc(schemas, paths({ allOf: [schemas.Data, one('Meta')] })));
      for (const { spec, warnings } of [both, inline]) {
        const { response, pagination } = operation(spec, 'listPets');
        expect(show(response)).toBe('Pet[]');
        expect(pagination).toMatchObject({ dataPath: 'data', endOfIteration: { kind: 'hasMore', path: 'has_more' } });
        expect(warnings).toEqual([]);
      }
      expect(operation(both.spec, 'listPets').pagination).toEqual(operation(inline.spec, 'listPets').pagination);
      // Two nullable wrappers apply as members do, and the body admits `null`.
      const nullable = await read(doc(schemas, paths({ allOf: [nul('Data'), nul('Meta')] })));
      expect(show(operation(nullable.spec, 'listPets').response)).toBe('nullable<ListPetsResponse>');
      expect(fieldsOf(model(nullable.spec, 'ListPetsResponse'))).toEqual(list);
    });
  });
});
