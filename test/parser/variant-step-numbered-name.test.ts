import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { SchemaObject } from '../../src/parser/schemas.js';
import { collectModelRefs, collectOperationTypeRefs } from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * workos/oagen#602: a discriminated `allOf` + `oneOf`/`anyOf` component's
 * variant steps by number when another model holds its name with another
 * shape (`CatEventCat2`), but `firstFreeVariantName` appended the number
 * bare, so a variant named from a const that ends in a digit read as
 * another version: `PetEvent`'s `pet.v2` beside a component `PetV2` of
 * other fields was `PetV22`, its nested `owner` object `PetV22Owner`, and
 * the mapping named `PetV22`. The step is now spelled as every numbered
 * model and enum name is (`numberedName`): behind `No` after a digit —
 * `PetV2No2` and `PetV2No2Owner`, then `PetV2No3` — and bare after a
 * letter still (`CatEventCat2`).
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(name: string, doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-variant-step-numbered-name-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

async function parse(label: string, doc: unknown): Promise<{ spec: ApiSpec; warnings: string[] }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const spec = await parseSpec(await writeSpec(`${label.replace(/[^\w.-]+/g, '_')}.json`, doc));
    return { spec, warnings: warn.mock.calls.map(([m]) => String(m)) };
  } finally {
    warn.mockRestore();
  }
}

const VERSIONS = ['3.1.0', '3.0.3'] as const;
type Version = (typeof VERSIONS)[number];

const str: SchemaObject = { type: 'string' };
const obj = (properties: Record<string, SchemaObject>, extra: SchemaObject = {}): SchemaObject => ({
  type: 'object',
  properties,
  ...extra,
});
const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });
/** A string pinned to `value`: `const` on 3.1, the single-value `enum` 3.0 spells it with. */
const pinned = (openapi: Version, value: string): SchemaObject =>
  openapi.startsWith('3.0') ? { type: 'string', enum: [value] } : { type: 'string', const: value };
const getOp = (operationId: string, name: string) => ({
  get: {
    operationId,
    responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref(name) } } } },
  },
});
const specDoc = (openapi: Version, paths: Record<string, unknown>, schemas: Record<string, unknown>) => ({
  openapi,
  info: { title: 'variant step', version: '1' },
  paths,
  components: { schemas },
});

/** `schemas` with its keys in `order`. */
const ordered = (schemas: Record<string, SchemaObject>, order: readonly string[]): Record<string, SchemaObject> =>
  Object.fromEntries(order.map((key) => [key, schemas[key]]));

/** Every ordering of `items`. */
const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

function show(type: TypeRef): string {
  switch (type.kind) {
    case 'array':
      return `${show(type.items)}[]`;
    case 'nullable':
      return `${show(type.inner)} | null`;
    case 'union':
      return `(${type.variants.map(show).join(' | ')})`;
    case 'model':
    case 'enum':
      return type.name;
    case 'primitive':
      return type.type;
    case 'map':
      return `map<${show(type.valueType)}>`;
    case 'literal':
      return JSON.stringify(type.value);
  }
}

const modelNames = (spec: ApiSpec): string[] => spec.models.map((m) => m.name);
const modelOf = (spec: ApiSpec, name: string): Model => {
  const model = spec.models.find((m) => m.name === name);
  if (!model) throw new Error(`model ${name} not found in ${modelNames(spec).join(', ')}`);
  return model;
};
/** Each field as `name: type`, `?` when optional, in model order. */
const fieldsOf = (spec: ApiSpec, name: string): string[] =>
  modelOf(spec, name).fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${show(f.type)}`);
const opsOf = (spec: ApiSpec): Record<string, Operation> =>
  Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));
const mappingOf = (spec: ApiSpec, name: string) => modelOf(spec, name).discriminator?.mapping;

/** Every type an operation or a model's field references. */
const allRefs = (spec: ApiSpec): TypeRef[] => [
  ...spec.services.flatMap((s) => s.operations.flatMap((op) => collectOperationTypeRefs(op))),
  ...spec.models.flatMap((m) => m.fields.map((f) => f.type)),
];

/** Nothing dangles, nothing is orphaned, and no name is both a model's and an enum's. */
function expectSound(spec: ApiSpec, componentNames: string[], label: string): void {
  const names = new Set(modelNames(spec));
  const referenced = new Set(allRefs(spec).flatMap(collectModelRefs));
  for (const m of spec.models)
    for (const target of Object.values(m.discriminator?.mapping ?? {})) referenced.add(target);
  expect(
    [...referenced].filter((name) => !names.has(name)),
    label,
  ).toEqual([]);
  expect(
    modelNames(spec).filter((name) => !componentNames.includes(name) && !referenced.has(name)),
    label,
  ).toEqual([]);
  const enumNames = new Set(spec.enums.map((e) => e.name));
  expect(
    modelNames(spec).filter((name) => enumNames.has(name)),
    label,
  ).toEqual([]);
}

/** `Event { id }`, the issue's base component. */
const event = obj({ id: str }, { required: ['id'] });
/** The issue's `PetEvent`: `Event` plus one of `petV2` (with a nested `owner`) or `petV3`, each with its `kind` required. */
const petEvent = (openapi: Version): SchemaObject => ({
  allOf: [
    ref('Event'),
    {
      oneOf: [
        obj({ kind: pinned(openapi, 'pet.v2'), meow: str, owner: obj({ name: str }) }, { required: ['kind'] }),
        obj({ kind: pinned(openapi, 'pet.v3'), bark: str }, { required: ['kind'] }),
      ],
    },
  ],
});
/** The issue's `PetV2` component, of another shape than the `pet.v2` variant. */
const petV2Component = obj({ a: str, b: str, c: str, d: str });
const issuePaths = {
  '/pet-events': getOp('getPetEvent', 'PetEvent'),
  '/pet-v2s': getOp('getPetV2', 'PetV2'),
};
/** The issue's document on `openapi`, its components in `order`. */
const issueDoc = (openapi: Version, order: readonly string[] = ['Event', 'PetEvent', 'PetV2']) =>
  specDoc(openapi, issuePaths, ordered({ Event: event, PetEvent: petEvent(openapi), PetV2: petV2Component }, order));

describe('#602', () => {
  it("the issue's document: the pet.v2 variant beside a component PetV2 of another shape is PetV2No2, never PetV22, its nested model and the mapping with it, on 3.1.0 and 3.0.3 in any order", async () => {
    for (const openapi of VERSIONS) {
      for (const order of permutations(['Event', 'PetEvent', 'PetV2'])) {
        const label = `${openapi} ${order.join(',')}`;
        const { spec, warnings } = await parse(`issue-${label}`, issueDoc(openapi, order));
        expect(modelNames(spec).sort(), label).toEqual(
          ['Event', 'PetEvent', 'PetV2No2', 'PetV2No2Owner', 'PetV3', 'PetV2'].sort(),
        );
        expect(modelOf(spec, 'PetEvent').discriminator, label).toEqual({
          property: 'kind',
          mapping: { 'pet.v2': 'PetV2No2', 'pet.v3': 'PetV3' },
        });
        expect(fieldsOf(spec, 'PetV2No2'), label).toEqual([
          'id: string',
          'kind: "pet.v2"',
          'meow?: string',
          'owner?: PetV2No2Owner',
        ]);
        expect(fieldsOf(spec, 'PetV2No2Owner'), label).toEqual(['name?: string']);
        expect(fieldsOf(spec, 'PetV3'), label).toEqual(['id: string', 'kind: "pet.v3"', 'bark?: string']);
        // The component keeps its name and its own fields; its operation still returns it.
        expect(fieldsOf(spec, 'PetV2'), label).toEqual(['a?: string', 'b?: string', 'c?: string', 'd?: string']);
        expect(show(opsOf(spec).getPetV2!.response), label).toBe('PetV2');
        expect(show(opsOf(spec).getPetEvent!.response), label).toBe('PetEvent');
        expect(warnings, label).toEqual([]);
        expectSound(spec, ['Event', 'PetEvent', 'PetV2'], label);
      }
    }
  });

  it('the third step: a component PetV2No2 of another shape too sends the variant to PetV2No3, its nested model with it', async () => {
    const paths = { ...issuePaths, '/pet-v2-no2s': getOp('getPetV2No2', 'PetV2No2') };
    for (const openapi of VERSIONS) {
      const schemas: Record<string, SchemaObject> = {
        Event: event,
        PetEvent: petEvent(openapi),
        PetV2: petV2Component,
        PetV2No2: obj({ e: str, f: str }),
      };
      const keys = Object.keys(schemas);
      for (const order of [keys, [...keys].reverse()]) {
        const label = `${openapi} ${order.join(',')}`;
        const { spec, warnings } = await parse(`third-${label}`, specDoc(openapi, paths, ordered(schemas, order)));
        expect(modelNames(spec).sort(), label).toEqual(
          ['Event', 'PetEvent', 'PetV2No3', 'PetV2No3Owner', 'PetV3', 'PetV2', 'PetV2No2'].sort(),
        );
        expect(mappingOf(spec, 'PetEvent'), label).toEqual({ 'pet.v2': 'PetV2No3', 'pet.v3': 'PetV3' });
        expect(fieldsOf(spec, 'PetV2No3'), label).toEqual([
          'id: string',
          'kind: "pet.v2"',
          'meow?: string',
          'owner?: PetV2No3Owner',
        ]);
        expect(fieldsOf(spec, 'PetV2No3Owner'), label).toEqual(['name?: string']);
        expect(fieldsOf(spec, 'PetV2No2'), label).toEqual(['e?: string', 'f?: string']);
        expect(show(opsOf(spec).getPetV2No2!.response), label).toBe('PetV2No2');
        expect(warnings, label).toEqual([]);
        expectSound(spec, keys, label);
      }
    }
  });

  it('a variant whose name ends in a letter still steps bare: CatEventCat2, then CatEventCat3', async () => {
    const catEvent = (openapi: Version): SchemaObject => ({
      allOf: [
        ref('Event'),
        {
          oneOf: [
            obj({ kind: pinned(openapi, 'cat'), meow: str, owner: obj({ name: str }) }, { required: ['kind'] }),
            obj({ kind: pinned(openapi, 'dog'), bark: str }, { required: ['kind'] }),
          ],
        },
      ],
    });
    const paths = {
      '/cat-events': getOp('getCatEvent', 'CatEvent'),
      '/cat-event-cats': getOp('getCatEventCat', 'CatEventCat'),
      '/cat-event-cat2s': getOp('getCatEventCat2', 'CatEventCat2'),
    };
    for (const openapi of VERSIONS) {
      const schemas: Record<string, SchemaObject> = {
        Event: event,
        CatEvent: catEvent(openapi),
        CatEventCat: obj({ a: str, b: str, c: str, d: str }),
        CatEventCat2: obj({ e: str, f: str }),
      };
      const keys = Object.keys(schemas);
      for (const order of [keys, [...keys].reverse()]) {
        const label = `${openapi} ${order.join(',')}`;
        const { spec, warnings } = await parse(`letter-${label}`, specDoc(openapi, paths, ordered(schemas, order)));
        expect(modelNames(spec).sort(), label).toEqual(
          [
            'Event',
            'CatEvent',
            'CatEventCat',
            'CatEventCat2',
            'CatEventCat3',
            'CatEventCat3Owner',
            'CatEventDog',
          ].sort(),
        );
        expect(mappingOf(spec, 'CatEvent'), label).toEqual({ cat: 'CatEventCat3', dog: 'CatEventDog' });
        expect(fieldsOf(spec, 'CatEventCat3'), label).toEqual([
          'id: string',
          'kind: "cat"',
          'meow?: string',
          'owner?: CatEventCat3Owner',
        ]);
        expect(warnings, label).toEqual([]);
        expectSound(spec, keys, label);
      }
    }
  });

  it('a name an earlier dispatcher in the document settled on is stepped the same way: PetV2No2 and PetV3No2 for the later one', async () => {
    // Two dispatchers whose variants pin the same consts with different shapes: the
    // variant names stand alone (`PetV2`, multi-word), so the second dispatcher in
    // document order steps past the first's.
    const dispatcher = (openapi: Version, v2: Record<string, SchemaObject>, v3: Record<string, SchemaObject>) => ({
      allOf: [
        ref('Event'),
        {
          oneOf: [
            obj({ kind: pinned(openapi, 'pet.v2'), ...v2 }, { required: ['kind'] }),
            obj({ kind: pinned(openapi, 'pet.v3'), ...v3 }, { required: ['kind'] }),
          ],
        },
      ],
    });
    const paths = {
      '/alpha-events': getOp('getAlphaEvent', 'AlphaEvent'),
      '/beta-events': getOp('getBetaEvent', 'BetaEvent'),
    };
    for (const openapi of VERSIONS) {
      const schemas: Record<string, SchemaObject> = {
        Event: event,
        AlphaEvent: dispatcher(openapi, { meow: str }, { bark: str }),
        BetaEvent: dispatcher(openapi, { purr: str, owner: obj({ name: str }) }, { woof: str }),
      };
      for (const [first, second] of [
        ['AlphaEvent', 'BetaEvent'],
        ['BetaEvent', 'AlphaEvent'],
      ] as const) {
        const order = ['Event', first, second];
        const label = `${openapi} ${order.join(',')}`;
        const { spec, warnings } = await parse(`earlier-${label}`, specDoc(openapi, paths, ordered(schemas, order)));
        expect(mappingOf(spec, first), label).toEqual({ 'pet.v2': 'PetV2', 'pet.v3': 'PetV3' });
        expect(mappingOf(spec, second), label).toEqual({ 'pet.v2': 'PetV2No2', 'pet.v3': 'PetV3No2' });
        const ownerOf = first === 'BetaEvent' ? 'PetV2Owner' : 'PetV2No2Owner';
        expect(modelNames(spec).sort(), label).toEqual(
          ['Event', 'AlphaEvent', 'BetaEvent', 'PetV2', 'PetV3', 'PetV2No2', 'PetV3No2', ownerOf].sort(),
        );
        expect(
          modelNames(spec).filter((name) => /\d\d/.test(name)),
          label,
        ).toEqual([]);
        expect(warnings, label).toEqual([]);
        expectSound(spec, Object.keys(schemas), label);
      }
    }
  });
});
