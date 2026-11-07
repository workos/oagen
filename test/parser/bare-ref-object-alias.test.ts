import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffCommand } from '../../src/cli/diff.js';
import { collectModelRefs, collectModelTypeRefs, collectOperationTypeRefs } from '../../src/ir/types.js';
import type { ApiSpec, Model, Operation, TypeRef } from '../../src/ir/types.js';

/**
 * Issue #618: a component written as a bare `$ref` to an object component
 * (`CatAlias: { $ref: Cat }`) was a model with no fields, every `$ref` to it
 * was typed as that empty model, and as a union variant it pinned no
 * discriminator value, while the same alias written `allOf: [{ $ref: Cat }]`
 * was a model carrying `Cat`'s fields (as a bare `$ref` alias of an enum,
 * array or primitive component was already read through to what it names;
 * #512, #560). The bare `$ref` is now read exactly as the `allOf` alias is:
 * a model of its own carrying the target's fields, `required` and
 * discriminator, with what is written beside the `$ref` as its own, through
 * a chain of aliases, in either declaration order, at every site that names
 * it; a chain that returns to itself is a fieldless model with one warning.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: 'string' };

/** The issue's `Cat`, verbatim. */
const Cat = { type: 'object', required: ['name'], properties: { name: str } };

/** `CatAlias` in each spelling the issue compares. */
const aliasOf = (name: string, spelling: 'ref' | 'allOf', beside: Record<string, unknown> = {}) =>
  spelling === 'ref' ? { ...ref(name), ...beside } : { allOf: [ref(name)], ...beside };

/** `GET /cats/{catId}` (`operationId: getCat`) returning `$ref: CatAlias`, as the issue writes it. */
const getCat = {
  '/cats/{catId}': {
    get: {
      operationId: 'getCat',
      parameters: [{ name: 'catId', in: 'path', required: true, schema: str }],
      responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('CatAlias') } } } },
    },
  },
};

/** One `GET` operation returning `$ref: <name>`, so the component is reachable. */
const getting = (name: string, operationId: string) => ({
  [`/${operationId}`]: {
    get: {
      operationId,
      responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref(name) } } } },
    },
  },
});

/** A document on `openapi` with the given components and paths (by default one operation returning `Holder`). */
function documentWith(
  openapi: string,
  schemas: Record<string, unknown>,
  paths: Record<string, unknown> = getting('Holder', 'getHolder'),
) {
  return { openapi, info: { title: 'repro', version: '1' }, paths, components: { schemas } };
}

/** The issue's `ref.json` / `allOf.json`. */
const issueRepro = (openapi: string, spelling: 'ref' | 'allOf') =>
  documentWith(openapi, { Cat, CatAlias: aliasOf('Cat', spelling) }, getCat);

/** `kind: { const: 'cat' }`, in the spelling the OAS version has for a single value. */
const pinned = (openapi: string, value: string) =>
  openapi.startsWith('3.0') ? { type: 'string', enum: [value] } : { const: value };

const show = (t: TypeRef): string => {
  switch (t.kind) {
    case 'model':
    case 'enum':
      return `${t.kind} ${t.name}`;
    case 'array':
      return `array<${show(t.items)}>`;
    case 'map':
      return `map<${show(t.valueType)}>`;
    case 'nullable':
      return `nullable<${show(t.inner)}>`;
    case 'literal':
      return `'${String(t.value)}'`;
    case 'union':
      return `union<${t.variants.map(show).join('|')}>`;
    case 'primitive':
      return t.type;
    default:
      return JSON.stringify(t);
  }
};

const modelByName = (spec: ApiSpec, name: string): Model | undefined => spec.models.find((m) => m.name === name);
const fieldsOf = (model: Model | undefined): string[] | undefined =>
  model?.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${show(f.type)}`);
const fieldType = (spec: ApiSpec, model: string, field: string): string | undefined => {
  const type = modelByName(spec, model)?.fields.find((f) => f.name === field)?.type;
  return type && show(type);
};
const operations = (spec: ApiSpec): Operation[] => spec.services.flatMap((service) => service.operations);
const operation = (spec: ApiSpec, name: string): Operation | undefined =>
  operations(spec).find((op) => op.name === name);
const sortedModels = (spec: ApiSpec): Model[] => [...spec.models].sort((a, b) => a.name.localeCompare(b.name));

/** Every model an operation or a model references is in `spec.models`, and every discriminator target is too. */
function expectSound(spec: ApiSpec): void {
  const known = new Set(spec.models.map((m) => m.name));
  const unresolved: string[] = [];
  for (const op of operations(spec)) {
    for (const type of collectOperationTypeRefs(op)) {
      for (const name of collectModelRefs(type)) if (!known.has(name)) unresolved.push(`${op.name} → ${name}`);
    }
  }
  for (const model of spec.models) {
    for (const type of collectModelTypeRefs(model)) {
      for (const name of collectModelRefs(type)) if (!known.has(name)) unresolved.push(`${model.name} → ${name}`);
    }
    for (const name of Object.values(model.discriminator?.mapping ?? {})) {
      if (!known.has(name)) unresolved.push(`${model.name}.discriminator → ${name}`);
    }
  }
  expect(unresolved).toEqual([]);
}

describe('#618', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let files = 0;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-618-'));
  });

  afterEach(async () => {
    warn.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function write(doc: unknown): Promise<string> {
    const specFile = path.join(tmpDir, `spec-${files++}.json`);
    await fs.writeFile(specFile, JSON.stringify(doc), 'utf-8');
    return specFile;
  }

  async function parseJson(doc: unknown): Promise<ApiSpec> {
    return parseSpec(await write(doc));
  }

  /** Every `console.warn` message so far, in order. */
  const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

  /** The IR of a document and of the same document with every `CatAlias`-style alias in `spellings` rewritten; the two must agree. */
  async function expectSpellingsAgree(
    openapi: string,
    schemas: (spelling: 'ref' | 'allOf') => Record<string, unknown>,
    paths?: Record<string, unknown>,
  ): Promise<ApiSpec> {
    const asRef = await parseJson(documentWith(openapi, schemas('ref'), paths));
    const asAllOf = await parseJson(documentWith(openapi, schemas('allOf'), paths));
    expect(asRef.models).toEqual(asAllOf.models);
    expect(asRef.enums).toEqual(asAllOf.enums);
    expect(asRef.services).toEqual(asAllOf.services);
    expectSound(asRef);
    return asRef;
  }

  describe.each(['3.1.0', '3.0.3'])("the issue's repro on OAS %s", (openapi) => {
    it('reads `ref.json` as `allOf.json`: `CatAlias { name: string }`, the response typed as it', async () => {
      const asRef = await parseJson(issueRepro(openapi, 'ref'));
      const asAllOf = await parseJson(issueRepro(openapi, 'allOf'));
      for (const [label, spec] of [
        ['ref.json', asRef],
        ['allOf.json', asAllOf],
      ] as const) {
        expect(
          spec.models.map((m) => `${m.name} { ${fieldsOf(m)!.join(', ')} }`),
          label,
        ).toEqual(['Cat { name: string }', 'CatAlias { name: string }']);
        expect(show(operation(spec, 'getCat')!.response), label).toBe('model CatAlias');
      }
      expect(asRef.models).toEqual(asAllOf.models);
      expect(asRef.services).toEqual(asAllOf.services);
      expect(warnings()).toEqual([]);
    });

    it('reads a `description` beside the `$ref` as the alias’s own, as beside the `allOf`', async () => {
      const beside = { description: 'A cat, by another name.' };
      const spec = await expectSpellingsAgree(
        openapi,
        (spelling) => ({ Cat, CatAlias: aliasOf('Cat', spelling, beside) }),
        getCat,
      );
      expect(fieldsOf(modelByName(spec, 'CatAlias'))).toEqual(['name: string']);
      expect(modelByName(spec, 'CatAlias')?.description).toBe('A cat, by another name.');
      expect(modelByName(spec, 'Cat')?.description).toBeUndefined();
      expect(warnings()).toEqual([]);
    });

    it('pins the discriminator value the target pins: `Pet: oneOf [CatAlias, Dog]` maps `{ cat: CatAlias, dog: Dog }`', async () => {
      const kinds = {
        Cat: { type: 'object', required: ['name', 'kind'], properties: { name: str, kind: pinned(openapi, 'cat') } },
        Dog: { type: 'object', required: ['name', 'kind'], properties: { name: str, kind: pinned(openapi, 'dog') } },
      };
      const paths = {
        ...getCat,
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', required: true, schema: str }],
            responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('Pet') } } } },
          },
        },
      };
      const spec = await expectSpellingsAgree(
        openapi,
        (spelling) => ({
          ...kinds,
          CatAlias: aliasOf('Cat', spelling),
          Pet: { oneOf: [ref('CatAlias'), ref('Dog')] },
          // The same union written inline on a field carries the same mapping.
          Owner: { type: 'object', properties: { pet: { oneOf: [ref('CatAlias'), ref('Dog')] } } },
        }),
        paths,
      );
      expect(fieldsOf(modelByName(spec, 'CatAlias'))).toEqual(['name: string', "kind: 'cat'"]);
      const pet = modelByName(spec, 'Pet');
      expect(pet?.variants?.map(show)).toEqual(['model CatAlias', 'model Dog']);
      expect(pet?.discriminator).toEqual({ property: 'kind', mapping: { cat: 'CatAlias', dog: 'Dog' } });
      const inline = modelByName(spec, 'Owner')?.fields[0]?.type;
      expect(inline?.kind).toBe('union');
      expect(inline?.kind === 'union' && inline.discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'CatAlias', dog: 'Dog' },
      });
      expect(warnings()).toEqual([]);
    });

    it('reports nothing between the two spellings in `oagen diff`, and exits 0', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const allOf = await write(issueRepro(openapi, 'allOf'));
      const asRef = await write(issueRepro(openapi, 'ref'));
      const report = diffSpecs(await parseSpec(allOf), await parseSpec(asRef));
      expect(report.changes).toEqual([]);
      expect(report.summary).toMatchObject({ breaking: 0, modified: 0, removed: 0, added: 0 });
      const reverse = diffSpecs(await parseSpec(asRef), await parseSpec(allOf));
      expect(reverse.changes).toEqual([]);
      const err: unknown = await diffCommand({ old: allOf, new: asRef }).catch((e: unknown) => e);
      expect(err).toMatchObject({ exitCode: 0 });
      log.mockRestore();
    });
  });

  describe('what is written beside the `$ref`', () => {
    it('is the alias’s own — text, link, flag, limits and `x-*` keys — and the target keeps its own', async () => {
      const beside = {
        description: 'An alias.',
        deprecated: true,
        maxProperties: 3,
        externalDocs: { url: 'https://example.com/alias' },
        'x-alias': 2,
      };
      const Widget = {
        type: 'object',
        required: ['x'],
        maxProperties: 9,
        description: 'A widget.',
        'x-widget': 1,
        properties: { x: str },
      };
      const spec = await expectSpellingsAgree('3.1.0', (spelling) => ({
        Widget,
        WidgetAlias: aliasOf('Widget', spelling, beside),
        Holder: { type: 'object', properties: { w: ref('WidgetAlias') } },
      }));
      expect(modelByName(spec, 'WidgetAlias')).toMatchObject({
        description: 'An alias.',
        deprecated: true,
        constraints: { maxProperties: 3 },
        externalDocs: { url: 'https://example.com/alias' },
        extensions: { 'x-alias': 2 },
      });
      expect(fieldsOf(modelByName(spec, 'WidgetAlias'))).toEqual(['x: string']);
      expect(modelByName(spec, 'Widget')).toMatchObject({
        description: 'A widget.',
        constraints: { maxProperties: 9 },
        extensions: { 'x-widget': 1 },
      });
      expect(modelByName(spec, 'Widget')?.deprecated).toBeUndefined();
      expect(warnings()).toEqual([]);
    });
  });

  describe('every site that names the alias', () => {
    const sites = {
      '/cats': {
        post: {
          operationId: 'createCat',
          requestBody: { required: true, content: { 'application/json': { schema: ref('CatAlias') } } },
          responses: { '201': { description: 'ok', content: { 'application/json': { schema: ref('CatAlias') } } } },
        },
        get: {
          operationId: 'listCats',
          parameters: [{ name: 'like', in: 'query', schema: ref('CatAlias') }],
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'array', items: ref('CatAlias') } } },
            },
          },
        },
      },
    };
    const Widget = {
      type: 'object',
      required: ['x'],
      properties: { x: str, owner: { type: 'object', properties: { name: str } } },
    };

    it('resolves to the alias model: a field, array items, map values, a request body, a parameter, a response', async () => {
      const spec = await expectSpellingsAgree(
        '3.1.0',
        (spelling) => ({
          Cat,
          CatAlias: aliasOf('Cat', spelling),
          Holder: {
            type: 'object',
            properties: {
              one: ref('CatAlias'),
              many: { type: 'array', items: ref('CatAlias') },
              byName: { type: 'object', additionalProperties: ref('CatAlias') },
            },
          },
        }),
        { ...sites, ...getting('Holder', 'getHolder') },
      );
      expect(fieldsOf(modelByName(spec, 'Holder'))).toEqual([
        'one?: model CatAlias',
        'many?: array<model CatAlias>',
        'byName?: map<model CatAlias>',
      ]);
      const create = operation(spec, 'createCat')!;
      expect(show(create.requestBody!)).toBe('model CatAlias');
      expect(show(create.response)).toBe('model CatAlias');
      const list = operation(spec, 'listCats')!;
      expect(show(list.queryParams[0]!.type)).toBe('model CatAlias');
      expect(show(list.response)).toBe('array<model CatAlias>');
      expect(fieldsOf(modelByName(spec, 'CatAlias'))).toEqual(['name: string']);
      expect(warnings()).toEqual([]);
    });

    it('merges an `allOf` member naming the alias as one naming the `allOf` alias: inherited fields typed under the alias', async () => {
      const spec = await expectSpellingsAgree('3.1.0', (spelling) => ({
        Widget,
        WidgetAlias: aliasOf('Widget', spelling),
        Holder: {
          type: 'object',
          properties: { merged: { allOf: [ref('WidgetAlias'), { type: 'object', properties: { extra: str } }] } },
        },
      }));
      // The alias's model types the inherited object under its own name, as
      // the `allOf` alias does, and the merge inherits that reference.
      expect(fieldsOf(modelByName(spec, 'WidgetAlias'))).toEqual(['x: string', 'owner?: model WidgetAliasOwner']);
      expect(fieldsOf(modelByName(spec, 'HolderMerged'))).toEqual([
        'x: string',
        'owner?: model WidgetAliasOwner',
        'extra?: string',
      ]);
      expect(fieldsOf(modelByName(spec, 'WidgetAliasOwner'))).toEqual(['name?: string']);
      expect(fieldsOf(modelByName(spec, 'WidgetOwner'))).toEqual(['name?: string']);
      expect(warnings()).toEqual([]);
    });
  });

  describe('chains, composing targets and declaration order', () => {
    it('carries the fields at every hop of a chain of aliases (`A → B → Cat`), each a model of its own', async () => {
      const spec = await expectSpellingsAgree('3.1.0', (spelling) => ({
        Cat,
        B: aliasOf('Cat', spelling),
        A: aliasOf('B', spelling),
        Holder: { type: 'object', properties: { a: ref('A'), b: ref('B') } },
      }));
      expect(fieldsOf(modelByName(spec, 'A'))).toEqual(['name: string']);
      expect(fieldsOf(modelByName(spec, 'B'))).toEqual(['name: string']);
      expect(fieldType(spec, 'Holder', 'a')).toBe('model A');
      expect(fieldType(spec, 'Holder', 'b')).toBe('model B');
      expect(warnings()).toEqual([]);
    });

    it('reads a bare `$ref` to a component that itself composes: `Puppy: { $ref: Dog }` carries `Pet`’s fields and `breed`', async () => {
      const spec = await expectSpellingsAgree('3.1.0', (spelling) => ({
        Pet: { type: 'object', required: ['name'], properties: { name: str } },
        Dog: { allOf: [ref('Pet'), { type: 'object', required: ['breed'], properties: { breed: str } }] },
        Puppy: aliasOf('Dog', spelling),
        Holder: { type: 'object', properties: { pup: ref('Puppy') } },
      }));
      expect(fieldsOf(modelByName(spec, 'Puppy'))).toEqual(['name: string', 'breed: string']);
      expect(fieldsOf(modelByName(spec, 'Puppy'))).toEqual(fieldsOf(modelByName(spec, 'Dog')));
      expect(fieldType(spec, 'Holder', 'pup')).toBe('model Puppy');
      expect(warnings()).toEqual([]);
    });

    it('reads a bare `$ref` to a dispatcher as the `allOf` alias is read: the base fields, the dispatch left to the target', async () => {
      const Pet = {
        allOf: [
          { type: 'object', required: ['id'], properties: { id: str } },
          {
            oneOf: [
              { type: 'object', properties: { kind: { const: 'cat' }, lives: { type: 'integer' } } },
              { type: 'object', properties: { kind: { const: 'dog' }, bark: { type: 'boolean' } } },
            ],
          },
        ],
      };
      const spec = await expectSpellingsAgree('3.1.0', (spelling) => ({
        Pet,
        PetAlias: aliasOf('Pet', spelling),
        Holder: { type: 'object', properties: { p: ref('PetAlias') } },
      }));
      expect(modelByName(spec, 'Pet')?.discriminator).toEqual({
        property: 'kind',
        mapping: { cat: 'PetCat', dog: 'PetDog' },
      });
      expect(fieldsOf(modelByName(spec, 'PetAlias'))).toEqual(['id: string']);
      expect(modelByName(spec, 'PetAlias')?.discriminator).toBeUndefined();
      expect(spec.models.map((m) => m.name).sort()).toEqual(['Holder', 'Pet', 'PetAlias', 'PetCat', 'PetDog']);
      expect(warnings()).toEqual([]);
    });

    it('gives the same IR whether the alias is declared before or after its target, and a chain in either order', async () => {
      const Holder = { type: 'object', properties: { a: ref('A'), c: ref('CatAlias') } };
      const B = ref('Cat');
      const A = ref('B');
      const CatAlias = ref('Cat');
      const forward = await parseJson(documentWith('3.1.0', { Cat, CatAlias, B, A, Holder }));
      const backward = await parseJson(documentWith('3.1.0', { Holder, A, B, CatAlias, Cat }));
      expect(sortedModels(backward)).toEqual(sortedModels(forward));
      expect(fieldsOf(modelByName(backward, 'A'))).toEqual(['name: string']);
      expect(fieldsOf(modelByName(backward, 'CatAlias'))).toEqual(['name: string']);
      expectSound(backward);
      expect(warnings()).toEqual([]);
    });
  });

  describe('a chain of bare `$ref`s that returns to itself', () => {
    it('does not loop: each component is a model with no fields, reported once, and a `$ref` to it resolves to it', async () => {
      // The bundler rejects a self-referencing pointer before the parser
      // runs, so the cycles are written through `transformSpec`, as a
      // consumer's hook could write them.
      const file = await write(
        documentWith('3.1.0', {
          Loop: { type: 'object' },
          A: { type: 'object' },
          B: { type: 'object' },
          Holder: { type: 'object', properties: { loop: ref('Loop'), a: ref('A'), b: ref('B') } },
        }),
      );
      const spec = await parseSpec(file, {
        transformSpec: (doc) => {
          const { schemas } = doc.components as { schemas: Record<string, unknown> };
          Object.assign(schemas, { Loop: ref('Loop'), A: ref('B'), B: ref('A') });
          return doc;
        },
      });
      for (const name of ['Loop', 'A', 'B']) expect(fieldsOf(modelByName(spec, name)), name).toEqual([]);
      expect(fieldsOf(modelByName(spec, 'Holder'))).toEqual(['loop?: model Loop', 'a?: model A', 'b?: model B']);
      expectSound(spec);
      const cycle = (key: string) =>
        `[oagen] Warning: Component schema "${key}" is a $ref that resolves to no component (a chain of $refs that returns to itself, or a $ref no component answers) — reading it as a model with no fields`;
      expect(warnings()).toEqual([cycle('Loop'), cycle('A'), cycle('B')]);
    });

    it('ends where the `allOf` reader ends a cycle reached through an `allOf` member, without a warning', async () => {
      const spec = await parseJson(
        documentWith('3.1.0', {
          C: ref('D'),
          D: { allOf: [ref('C'), { type: 'object', properties: { d: str } }] },
          Holder: { type: 'object', properties: { c: ref('C'), d: ref('D') } },
        }),
      );
      expect(fieldsOf(modelByName(spec, 'C'))).toEqual(['d?: string']);
      expect(fieldsOf(modelByName(spec, 'D'))).toEqual(['d?: string']);
      expectSound(spec);
      expect(warnings()).toEqual([]);
    });
  });

  describe('a bare `$ref` alias of an enum, array or primitive component', () => {
    it('is still read through to what it names, with no model of its own (#512, #560)', async () => {
      const spec = await parseJson(
        documentWith('3.1.0', {
          Cat,
          Kind: { type: 'string', enum: ['cat', 'dog'] },
          KindAlias: ref('Kind'),
          Cats: { type: 'array', items: ref('Cat') },
          CatsAlias: ref('Cats'),
          Id: { type: 'string', format: 'uuid' },
          IdAlias: ref('Id'),
          Holder: {
            type: 'object',
            properties: { kind: ref('KindAlias'), cats: ref('CatsAlias'), id: ref('IdAlias') },
          },
        }),
      );
      expect(fieldsOf(modelByName(spec, 'Holder'))).toEqual([
        'kind?: enum Kind',
        'cats?: array<model Cat>',
        'id?: string',
      ]);
      expect(spec.models.map((m) => m.name).sort()).toEqual(['Cat', 'Holder']);
      expect(spec.enums.map((e) => e.name)).toEqual(['Kind']);
      expect(warnings()).toEqual([]);
    });
  });

  describe('what an alias writes beside its `$ref` (Greptile, #618 review)', () => {
    /** `Cat` with `name` optional, so a `required` written beside a `$ref` to it is the only thing that makes `name` required. */
    const unrequired = { type: 'object', properties: { name: str } };
    const extra = { type: 'object', properties: { extra: str } };

    it.each(['3.1.0', '3.0.3'])(
      'reads `required` beside an intermediate `$ref` at every hop and in a merge, as beside an `allOf`, on OAS %s',
      async (openapi) => {
        // Greptile's case: `B.name` was required, `A.name` optional.
        const spec = await expectSpellingsAgree(openapi, (spelling) => ({
          Cat: unrequired,
          B: aliasOf('Cat', spelling, { required: ['name'] }),
          A: ref('B'),
          A2: { allOf: [ref('B')] },
          Holder: {
            type: 'object',
            properties: { a: ref('A'), viaA: { allOf: [ref('A'), extra] }, viaB: { allOf: [ref('B'), extra] } },
          },
        }));
        expect(fieldsOf(modelByName(spec, 'Cat'))).toEqual(['name?: string']);
        for (const name of ['B', 'A', 'A2']) expect(fieldsOf(modelByName(spec, name)), name).toEqual(['name: string']);
        expect(fieldsOf(modelByName(spec, 'HolderViaA'))).toEqual(['name: string', 'extra?: string']);
        expect(fieldsOf(modelByName(spec, 'HolderViaB'))).toEqual(['name: string', 'extra?: string']);
        expect(warnings()).toEqual([]);
      },
    );

    it('reads `required` beside a `$ref` member of an `allOf`, as beside a nested `allOf` of the reference', async () => {
      const schemas = (member: Record<string, unknown>) => ({
        Cat: unrequired,
        Dog: { allOf: [member] },
        Holder: { type: 'object', properties: { d: ref('Dog'), merged: { allOf: [member, extra] } } },
      });
      const asRef = await parseJson(documentWith('3.1.0', schemas({ ...ref('Cat'), required: ['name'] })));
      const asAllOf = await parseJson(documentWith('3.1.0', schemas({ allOf: [ref('Cat')], required: ['name'] })));
      expect(fieldsOf(modelByName(asRef, 'Dog'))).toEqual(['name: string']);
      expect(fieldsOf(modelByName(asRef, 'HolderMerged'))).toEqual(['name: string', 'extra?: string']);
      expect(asRef.models).toEqual(asAllOf.models);
      expectSound(asRef);
      expect(warnings()).toEqual([]);
    });

    it('reads a union beside an intermediate `$ref` as beside an `allOf`: flattened, never a variant axis of the alias', async () => {
      const spec = await expectSpellingsAgree('3.1.0', (spelling) => ({
        Cat: unrequired,
        B: aliasOf('Cat', spelling, {
          oneOf: [
            { type: 'object', properties: { a: str } },
            { type: 'object', properties: { b: str } },
          ],
        }),
        A: ref('B'),
        Holder: { type: 'object', properties: { a: ref('A'), merged: { allOf: [ref('A'), extra] } } },
      }));
      expect(fieldsOf(modelByName(spec, 'B'))).toEqual(['name?: string', 'a?: string', 'b?: string']);
      expect(fieldsOf(modelByName(spec, 'A'))).toEqual(['name?: string', 'a?: string', 'b?: string']);
      expect(modelByName(spec, 'A')?.discriminator).toBeUndefined();
      expect(fieldsOf(modelByName(spec, 'HolderMerged'))).toEqual([
        'name?: string',
        'a?: string',
        'b?: string',
        'extra?: string',
      ]);
      expect(spec.models.map((m) => m.name).sort()).toEqual(['A', 'B', 'Cat', 'Holder', 'HolderMerged']);
      expect(warnings()).toEqual([]);
    });

    it('reads a `discriminator` beside an intermediate `$ref` as beside an `allOf`', async () => {
      const kinds = {
        Cat: { type: 'object', properties: { name: str, kind: { const: 'cat' } } },
        Dog: { type: 'object', properties: { name: str, kind: { const: 'dog' } } },
        Pet: { oneOf: [ref('Cat'), ref('Dog')] },
      };
      const discriminator = {
        propertyName: 'kind',
        mapping: { feline: '#/components/schemas/Cat', canine: '#/components/schemas/Dog' },
      };
      const spec = await expectSpellingsAgree('3.1.0', (spelling) => ({
        ...kinds,
        B: aliasOf('Pet', spelling, { discriminator }),
        A: ref('B'),
        Holder: { type: 'object', properties: { a: ref('A'), b: ref('B') } },
      }));
      // `B` dispatches by the keyword written beside its `$ref`, as it does
      // beside an `allOf`; `A` leaves the dispatch to `B`, as an alias of
      // any dispatcher does (above).
      expect(modelByName(spec, 'B')?.discriminator).toEqual({
        property: 'kind',
        mapping: { feline: 'Cat', canine: 'Dog' },
      });
      expect(modelByName(spec, 'A')?.discriminator).toBeUndefined();
      expect(fieldsOf(modelByName(spec, 'A'))).toEqual(fieldsOf(modelByName(spec, 'B')));
      expect(warnings()).toEqual([]);
    });

    it('still ends a cycle through an alias that writes `required` beside its `$ref`, reported once per component', async () => {
      const file = await write(
        documentWith('3.1.0', {
          A: { type: 'object' },
          B: { type: 'object' },
          Holder: { type: 'object', properties: { a: ref('A'), b: ref('B') } },
        }),
      );
      const spec = await parseSpec(file, {
        transformSpec: (doc) => {
          const { schemas } = doc.components as { schemas: Record<string, unknown> };
          Object.assign(schemas, { A: ref('B'), B: { ...ref('A'), required: ['x'] } });
          return doc;
        },
      });
      expect(fieldsOf(modelByName(spec, 'A'))).toEqual([]);
      expect(fieldsOf(modelByName(spec, 'B'))).toEqual([]);
      expectSound(spec);
      expect(warnings().map((w: string) => w.slice(0, 40))).toEqual([
        '[oagen] Warning: Component schema "A" is',
        '[oagen] Warning: Component schema "B" is',
      ]);
    });
  });
});
