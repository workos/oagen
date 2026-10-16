import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractSchemas,
  extractInlineModelsFromSchemas,
  clearSchemaNameTransform,
  deprecatedEntry,
} from '../../src/parser/schemas.js';
import { extractOperations } from '../../src/parser/operations.js';
import { collapseJsonSuffixModels } from '../../src/parser/normalize-inline-models.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { Model } from '../../src/ir/types.js';

/** `name → deprecated` for every model, so an absent key shows as `undefined`. */
const flags = (models: Model[]): Record<string, boolean | undefined> =>
  Object.fromEntries(models.map((m) => [m.name, m.deprecated]));

/** An inline object schema with one string property, plus whatever `extra` says. */
const obj = (extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties: { k: { type: 'string' } },
  ...extra,
});

/** A minimal OpenAPI 3.1 document around `schemas` (and optional `paths`). */
const specDoc = (schemas: Record<string, unknown>, paths: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'nullable', version: '1' },
  paths,
  components: { schemas },
});

/** `name → { deprecated, fields }`, so a model that lost its fields is visible beside its flag. */
const shapes = (models: Model[]) =>
  Object.fromEntries(models.map((m) => [m.name, { deprecated: m.deprecated, fields: m.fields.map((f) => f.name) }]));

/** A GET operation whose 200 response wraps `data` in a one-property object (a wrapped resource). */
const wrappedResource = (data: Record<string, unknown>, operationId: string) => ({
  get: {
    operationId,
    responses: {
      '200': {
        description: 'ok',
        content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data } } } },
      },
    },
  },
});

/** An inline resource pinned by an `object` const, as a wrapped resource's variant. */
const constResource = (name: string, extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties: { object: { const: name }, k: { type: 'string' } },
  ...extra,
});

describe('deprecatedEntry', () => {
  it('yields { deprecated: true } only when the schema says so', () => {
    expect(deprecatedEntry({ deprecated: true })).toEqual({ deprecated: true });
    expect(deprecatedEntry({ deprecated: false })).toEqual({});
    expect(deprecatedEntry({})).toEqual({});
  });
});

describe('extractSchemas – deprecated', () => {
  afterEach(() => clearSchemaNameTransform());

  it('marks a deprecated component model and leaves the key absent otherwise (issue #215)', () => {
    const { models } = extractSchemas({
      LegacyPet: {
        deprecated: true,
        description: 'Use `Pet` instead.',
        type: 'object',
        properties: { name: { type: 'string' } },
      },
      Pet: { type: 'object', properties: { name: { type: 'string' } } },
      Toy: { deprecated: false, type: 'object', properties: { name: { type: 'string' } } },
    });
    const byName = new Map(models.map((m) => [m.name, m]));
    expect(byName.get('LegacyPet')).toMatchObject({ deprecated: true, description: 'Use `Pet` instead.' });
    // Absent, not `false`, so existing snapshots of live models stay byte-identical.
    expect(byName.get('Pet')).not.toHaveProperty('deprecated');
    expect(byName.get('Toy')).not.toHaveProperty('deprecated');
  });

  it('marks a deprecated component enum and leaves the key absent otherwise', () => {
    const { enums } = extractSchemas({
      LegacyState: { deprecated: true, type: 'string', enum: ['on', 'off'], default: 'on' },
      State: { type: 'string', enum: ['on', 'off'] },
    });
    const byName = new Map(enums.map((e) => [e.name, e]));
    expect(byName.get('LegacyState')).toMatchObject({ deprecated: true, default: 'on' });
    expect(byName.get('State')).not.toHaveProperty('deprecated');
  });

  it('deprecates an allOf model from its own wrapper only, never from a member', () => {
    const { models } = extractSchemas({
      Base: { deprecated: true, type: 'object', properties: { id: { type: 'string' } } },
      Composed: {
        allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { extra: { type: 'string' } } }],
      },
      LegacyComposed: {
        deprecated: true,
        allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { extra: { type: 'string' } } }],
      },
      InlineMember: { allOf: [{ deprecated: true, type: 'object', properties: { id: { type: 'string' } } }] },
    });
    expect(flags(models)).toEqual({
      Base: true,
      Composed: undefined,
      LegacyComposed: true,
      InlineMember: undefined,
    });
  });

  it('deprecates a discriminated allOf+oneOf variant from its own flag; the wrapper deprecates the dispatcher only', () => {
    const { models } = extractSchemas({
      Event: {
        deprecated: true,
        allOf: [
          { type: 'object', properties: { id: { type: 'string' } } },
          {
            oneOf: [
              { deprecated: true, type: 'object', properties: { event: { const: 'user.created' } } },
              { type: 'object', properties: { event: { const: 'user.deleted' } } },
            ],
          },
        ],
      },
    });
    const byName = new Map(models.map((m) => [m.name, m]));
    expect(byName.get('Event')?.discriminator?.property).toBe('event');
    expect(flags(models)).toEqual({ Event: true, UserCreated: true, UserDeleted: undefined });
  });

  it('carries a deprecated allOf-wrapped field inside a variant onto its nested model', () => {
    const { models } = extractSchemas({
      Event: {
        allOf: [
          { type: 'object', properties: { id: { type: 'string' } } },
          {
            oneOf: [
              {
                type: 'object',
                properties: {
                  event: { const: 'user.created' },
                  meta: { deprecated: true, allOf: [{ type: 'object', properties: { k: { type: 'string' } } }] },
                  live: { allOf: [{ deprecated: true, type: 'object', properties: { k: { type: 'string' } } }] },
                },
              },
              { type: 'object', properties: { event: { const: 'user.deleted' } } },
            ],
          },
        ],
      },
    });
    expect(flags(models)).toMatchInlineSnapshot(`
      {
        "Event": undefined,
        "UserCreated": undefined,
        "UserCreatedLive": undefined,
        "UserCreatedMeta": true,
        "UserDeleted": undefined,
      }
    `);
  });

  it('carries deprecated onto the inline models built from a component’s fields', () => {
    const schemas = {
      Thing: {
        type: 'object',
        properties: {
          meta: { deprecated: true, type: 'object', properties: { a: { type: 'string' } } },
          live: { type: 'object', properties: { a: { type: 'string' } } },
          tags: { type: 'array', items: { deprecated: true, type: 'object', properties: { k: { type: 'string' } } } },
          // A nullable wrapper: the flag is the field schema's (the wrapper's,
          // as Field.deprecated reads it), and the model is built from its
          // single object branch; a flag on the branch itself is not read.
          maybe: {
            deprecated: true,
            anyOf: [{ type: 'object', properties: { b: { type: 'string' } } }, { type: 'null' }],
          },
          branchOnly: {
            anyOf: [{ deprecated: true, type: 'object', properties: { b: { type: 'string' } } }, { type: 'null' }],
          },
          // An allOf field: the wrapper's flag, not a member's.
          merged: { deprecated: true, allOf: [{ type: 'object', properties: { c: { type: 'string' } } }] },
          memberOnly: { allOf: [{ deprecated: true, type: 'object', properties: { c: { type: 'string' } } }] },
          shape: {
            oneOf: [
              { deprecated: true, type: 'object', properties: { kind: { const: 'circle' }, r: { type: 'number' } } },
              { type: 'object', properties: { kind: { const: 'square' }, side: { type: 'number' } } },
            ],
          },
        },
      },
    };
    // The component extractor's nested collection and the field extractor
    // both materialize these; the flag must come out the same from each.
    const { models } = extractSchemas(schemas);
    expect(flags(models)).toMatchInlineSnapshot(`
      {
        "SquareThingShape": undefined,
        "Thing": undefined,
        "ThingLive": undefined,
        "ThingMeta": true,
        "ThingShape": true,
        "ThingTags": true,
      }
    `);
    expect(flags(extractInlineModelsFromSchemas(schemas))).toMatchInlineSnapshot(`
      {
        "SquareThingShape": undefined,
        "ThingBranchOnly": undefined,
        "ThingLive": undefined,
        "ThingMaybe": true,
        "ThingMemberOnly": undefined,
        "ThingMerged": true,
        "ThingMeta": true,
        "ThingShape": true,
        "ThingTags": true,
      }
    `);
  });

  it('builds a nullable oneOf property’s model with the same flag from both extractors', () => {
    // `mergeFieldInlineModels` keeps the component extractor's copy, so that
    // copy must already carry the wrapper's flag — it cannot rely on the
    // field extractor getting it right later.
    const schemas = {
      Thing: {
        type: 'object',
        properties: {
          wrapper: { deprecated: true, oneOf: [obj(), { type: 'null' }] },
          branch: { oneOf: [obj({ deprecated: true }), { type: 'null' }] },
        },
      },
    };
    expect(flags(extractSchemas(schemas).models)).toEqual({
      Thing: undefined,
      ThingWrapper: true,
      ThingBranch: undefined,
    });
    expect(flags(extractInlineModelsFromSchemas(schemas))).toEqual({ ThingWrapper: true, ThingBranch: undefined });
  });
});

describe('extractOperations – deprecated', () => {
  const body = (schema: Record<string, unknown>, operationId: string) => ({
    post: {
      operationId,
      requestBody: { content: { 'application/json': { schema } } },
      responses: { '201': { description: 'created' } },
    },
  });

  it('carries deprecated on inline request body models and oneOf body variants', () => {
    const { inlineModels } = extractOperations({
      '/pets': body({ deprecated: true, type: 'object', properties: { name: { type: 'string' } } }, 'createPet'),
      '/toys': body(
        {
          oneOf: [
            { deprecated: true, type: 'object', properties: { kind: { const: 'ball' } } },
            { type: 'object', properties: { kind: { const: 'bat' } } },
          ],
        },
        'createToy',
      ),
      // A discriminated body merges its variants into one model, which takes
      // the wrapper's flag; a variant's own flag has no model left to sit on.
      '/hats': body(
        {
          deprecated: true,
          discriminator: { propertyName: 'kind' },
          oneOf: [
            { type: 'object', required: ['kind'], properties: { kind: { const: 'cap' }, brim: { type: 'number' } } },
            { type: 'object', required: ['kind'], properties: { kind: { const: 'beanie' } } },
          ],
        },
        'createHat',
      ),
    });
    expect(flags(inlineModels)).toMatchInlineSnapshot(`
      {
        "BallCreateToyRequest": true,
        "BatCreateToyRequest": undefined,
        "CreateHatRequest": true,
        "CreatePetRequest": true,
      }
    `);
  });

  it('carries deprecated on inline response models, including an allOf-merged response', () => {
    const response = (schema: Record<string, unknown>, operationId: string) => ({
      get: {
        operationId,
        responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
      },
    });
    const { inlineModels } = extractOperations({
      '/a': response({ deprecated: true, type: 'object', properties: { x: { type: 'string' } } }, 'getA'),
      '/b': response(
        {
          deprecated: true,
          allOf: [
            { type: 'object', properties: { x: { type: 'string' } } },
            { type: 'object', properties: { y: { type: 'string' } } },
          ],
        },
        'getB',
      ),
      '/c': response(
        {
          allOf: [
            { deprecated: true, type: 'object', properties: { x: { type: 'string' } } },
            { type: 'object', properties: { y: { type: 'string' } } },
          ],
        },
        'getC',
      ),
    });
    expect(flags(inlineModels)).toMatchInlineSnapshot(`
      {
        "GetAResponse": true,
        "GetBResponse": true,
        "GetCResponse": undefined,
      }
    `);
  });

  it('applies the wrapper rule to a nullable request body and a nullable wrapped resource', () => {
    const wrapped = (data: Record<string, unknown>, operationId: string) => ({
      get: {
        operationId,
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': { schema: { type: 'object', required: ['data'], properties: { data } } },
            },
          },
        },
      },
    });
    const resource = (name: string, extra: Record<string, unknown> = {}) => ({
      type: 'object',
      properties: { object: { const: name }, k: { type: 'string' } },
      ...extra,
    });
    const { inlineModels } = extractOperations({
      '/a': body(
        { deprecated: true, oneOf: [obj({ properties: { kind: { const: 'a' } } }), { type: 'null' }] },
        'createA',
      ),
      '/b': body(
        { oneOf: [obj({ deprecated: true, properties: { kind: { const: 'b' } } }), { type: 'null' }] },
        'createB',
      ),
      '/c': wrapped({ deprecated: true, oneOf: [resource('thing_c'), { type: 'null' }] }, 'getC'),
      '/d': wrapped({ oneOf: [resource('thing_d', { deprecated: true }), { type: 'null' }] }, 'getD'),
    });
    expect(flags(inlineModels)).toMatchInlineSnapshot(`
      {
        "ACreateARequest": true,
        "BCreateBRequest": undefined,
        "ThingC": true,
        "ThingD": undefined,
      }
    `);
  });

  it('builds every variant of a nullable multi-variant union body and wrapped resource as written', () => {
    // `type: ['object', 'null']` beside a multi-variant `oneOf` unwraps to a
    // copy that still carries the union; it is not a branch, so each variant
    // is built from itself, keeps its fields and its own flag, and the
    // wrapper's flag is not carried onto it.
    const { inlineModels } = extractOperations({
      '/a': body(
        {
          deprecated: true,
          type: ['object', 'null'],
          oneOf: [
            obj({ properties: { kind: { const: 'a' }, k: { type: 'string' } } }),
            obj({ deprecated: true, properties: { kind: { const: 'b' }, k: { type: 'string' } } }),
          ],
        },
        'createA',
      ),
      '/c': wrappedResource(
        {
          deprecated: true,
          type: ['object', 'null'],
          oneOf: [constResource('thing_x'), constResource('thing_y', { deprecated: true })],
        },
        'getC',
      ),
    });
    for (const m of inlineModels) expect(m.fields.length, m.name).toBeGreaterThan(0);
    expect(shapes(inlineModels)).toMatchInlineSnapshot(`
      {
        "ACreateARequest": {
          "deprecated": undefined,
          "fields": [
            "kind",
            "k",
          ],
        },
        "BCreateARequest": {
          "deprecated": true,
          "fields": [
            "kind",
            "k",
          ],
        },
        "ThingX": {
          "deprecated": undefined,
          "fields": [
            "object",
            "k",
          ],
        },
      }
    `);
  });
});

describe('collapseJsonSuffixModels – deprecated', () => {
  it('keeps the base model’s own flag and does not take the folded Json model’s', () => {
    const field = (name: string) => ({ name, type: { kind: 'primitive', type: 'string' } as const, required: false });
    const models: Model[] = [
      { name: 'Widget', fields: [field('a')] },
      { name: 'WidgetJson', deprecated: true, fields: [field('a'), field('b')] },
      { name: 'Gadget', deprecated: true, fields: [field('a')] },
      { name: 'GadgetJson', fields: [field('a'), field('b')] },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const merged = collapseJsonSuffixModels(models, []);
      expect(merged.map((m) => m.name)).toEqual(['Widget', 'Gadget']);
      expect(merged.find((m) => m.name === 'Widget')).not.toHaveProperty('deprecated');
      expect(merged.find((m) => m.name === 'Gadget')).toMatchObject({ deprecated: true });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('parseSpec – deprecated', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function writeSpec(name: string, doc: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-deprecated-'));
    dirs.push(dir);
    const file = path.join(dir, name);
    await fs.writeFile(file, JSON.stringify(doc));
    return file;
  }

  it('carries deprecated on component models and enums end to end (issue #215 repro)', async () => {
    const file = await writeSpec('repro.json', {
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      paths: {
        '/pets/{petId}': {
          get: {
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/LegacyPet' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          LegacyPet: {
            deprecated: true,
            description: 'Use `Pet` instead.',
            type: 'object',
            properties: {
              name: { type: 'string' },
              state: { $ref: '#/components/schemas/LegacyState' },
              owner: { deprecated: true, type: 'object', properties: { name: { type: 'string' } } },
            },
          },
          Pet: { type: 'object', properties: { name: { type: 'string' } } },
          LegacyState: { deprecated: true, type: 'string', enum: ['on', 'off'] },
          State: { type: 'string', enum: ['on', 'off'] },
        },
      },
    });
    const spec = await parseSpec(file);
    expect(spec.models.find(({ name }) => name === 'LegacyPet')).toMatchObject({
      deprecated: true,
      description: 'Use `Pet` instead.',
    });
    expect(spec.models.find(({ name }) => name === 'Pet')).not.toHaveProperty('deprecated');
    expect(flags(spec.models)).toEqual({ LegacyPet: true, Pet: undefined, LegacyPetOwner: true });
    expect(spec.enums.find(({ name }) => name === 'LegacyState')).toMatchObject({ deprecated: true });
    expect(spec.enums.find(({ name }) => name === 'State')).not.toHaveProperty('deprecated');
    // The field-level flag is unchanged by the model-level one.
    const owner = spec.models.find(({ name }) => name === 'LegacyPet')?.fields.find((f) => f.name === 'owner');
    expect(owner?.deprecated).toBe(true);
  });

  it('gives a nullable property’s model the wrapper’s flag, not the branch’s, however it is spelled', async () => {
    const file = await writeSpec(
      'nullable.json',
      specDoc({
        Thing: {
          type: 'object',
          properties: {
            one_of_wrapper: { deprecated: true, oneOf: [obj(), { type: 'null' }] },
            one_of_branch: { oneOf: [obj({ deprecated: true }), { type: 'null' }] },
            any_of_wrapper: { deprecated: true, anyOf: [obj(), { type: 'null' }] },
            any_of_branch: { anyOf: [obj({ deprecated: true }), { type: 'null' }] },
            type_array: obj({ deprecated: true, type: ['object', 'null'] }),
            nullable_flag: obj({ deprecated: true, nullable: true }),
          },
        },
      }),
    );
    const spec = await parseSpec(file);
    expect(flags(spec.models)).toMatchInlineSnapshot(`
      {
        "Thing": undefined,
        "ThingAnyOfBranch": undefined,
        "ThingAnyOfWrapper": true,
        "ThingNullableFlag": true,
        "ThingOneOfBranch": undefined,
        "ThingOneOfWrapper": true,
        "ThingTypeArray": true,
      }
    `);
    // The field reads the same keyword, so each field agrees with its model.
    const thing = spec.models.find((m) => m.name === 'Thing')!;
    expect(Object.fromEntries(thing.fields.map((f) => [f.name, f.deprecated]))).toMatchInlineSnapshot(`
      {
        "any_of_branch": undefined,
        "any_of_wrapper": true,
        "nullable_flag": true,
        "one_of_branch": undefined,
        "one_of_wrapper": true,
        "type_array": true,
      }
    `);
  });

  it('applies the wrapper rule two levels down', async () => {
    const file = await writeSpec(
      'nested.json',
      specDoc({
        Thing: {
          type: 'object',
          properties: {
            outer: {
              type: 'object',
              properties: {
                inner: { deprecated: true, oneOf: [obj(), { type: 'null' }] },
                inner_branch: { oneOf: [obj({ deprecated: true }), { type: 'null' }] },
              },
            },
          },
        },
      }),
    );
    expect(flags((await parseSpec(file)).models)).toMatchInlineSnapshot(`
      {
        "Thing": undefined,
        "ThingOuter": undefined,
        "ThingOuterInner": true,
        "ThingOuterInnerBranch": undefined,
      }
    `);
  });

  it('applies the wrapper rule inside a discriminated allOf+oneOf variant', async () => {
    const file = await writeSpec(
      'variant.json',
      specDoc({
        Event: {
          allOf: [
            { type: 'object', properties: { id: { type: 'string' } } },
            {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    event: { const: 'user.created' },
                    meta: { deprecated: true, oneOf: [obj(), { type: 'null' }] },
                    meta_branch: { oneOf: [obj({ deprecated: true }), { type: 'null' }] },
                  },
                },
                { type: 'object', properties: { event: { const: 'user.deleted' } } },
              ],
            },
          ],
        },
      }),
    );
    expect(flags((await parseSpec(file)).models)).toMatchInlineSnapshot(`
      {
        "Event": undefined,
        "UserCreated": undefined,
        "UserCreatedMeta": true,
        "UserCreatedMetaBranch": undefined,
        "UserDeleted": undefined,
      }
    `);
  });

  it('applies the wrapper rule to nullable array items, and keeps an item model live under a deprecated array field', async () => {
    const file = await writeSpec(
      'items.json',
      specDoc({
        Thing: {
          type: 'object',
          properties: {
            tags: { type: 'array', items: { deprecated: true, oneOf: [obj(), { type: 'null' }] } },
            tags_branch: { type: 'array', items: { oneOf: [obj({ deprecated: true }), { type: 'null' }] } },
            // The array field is deprecated; its items schema is not, and the
            // item model is that schema's own.
            plain: { deprecated: true, type: 'array', items: obj() },
          },
        },
      }),
    );
    expect(flags((await parseSpec(file)).models)).toMatchInlineSnapshot(`
      {
        "Thing": undefined,
        "ThingPlain": undefined,
        "ThingTags": true,
        "ThingTagsBranch": undefined,
      }
    `);
  });

  it('builds every variant of a nullable multi-variant union property with its fields and its own flag', async () => {
    const circle = obj({ properties: { kind: { const: 'circle' }, r: { type: 'number' } } });
    const square = obj({ deprecated: true, properties: { kind: { const: 'square' }, side: { type: 'number' } } });
    const file = await writeSpec(
      'union.json',
      specDoc({
        Thing: {
          type: 'object',
          properties: {
            shape: { deprecated: true, type: ['object', 'null'], oneOf: [circle, square] },
            outer: {
              type: 'object',
              properties: { shape: { deprecated: true, type: ['object', 'null'], oneOf: [circle, square] } },
            },
            // The single-branch form, even beside a type array, still
            // collapses onto its one branch with the wrapper's flag.
            maybe: { deprecated: true, type: ['object', 'null'], oneOf: [obj(), { type: 'null' }] },
          },
        },
      }),
    );
    const spec = await parseSpec(file);
    for (const m of spec.models) expect(m.fields.length, m.name).toBeGreaterThan(0);
    expect(shapes(spec.models)).toMatchInlineSnapshot(`
      {
        "SquareThingOuterShape": {
          "deprecated": true,
          "fields": [
            "kind",
            "side",
          ],
        },
        "SquareThingShape": {
          "deprecated": true,
          "fields": [
            "kind",
            "side",
          ],
        },
        "Thing": {
          "deprecated": undefined,
          "fields": [
            "shape",
            "outer",
            "maybe",
          ],
        },
        "ThingMaybe": {
          "deprecated": true,
          "fields": [
            "k",
          ],
        },
        "ThingOuter": {
          "deprecated": undefined,
          "fields": [
            "shape",
          ],
        },
        "ThingOuterShape": {
          "deprecated": undefined,
          "fields": [
            "kind",
            "r",
          ],
        },
        "ThingShape": {
          "deprecated": undefined,
          "fields": [
            "kind",
            "r",
          ],
        },
      }
    `);
    // The wrapper's flag stays on the field that declares the union.
    const thing = spec.models.find((m) => m.name === 'Thing')!;
    expect(thing.fields.find((f) => f.name === 'shape')?.deprecated).toBe(true);
  });

  it('builds every variant of a nullable multi-variant union inside a discriminated variant as written', async () => {
    const circle = obj({ properties: { kind: { const: 'circle' }, r: { type: 'number' } } });
    const square = obj({ deprecated: true, properties: { kind: { const: 'square' }, side: { type: 'number' } } });
    const file = await writeSpec(
      'variant-union.json',
      specDoc({
        Event: {
          allOf: [
            { type: 'object', properties: { id: { type: 'string' } } },
            {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    event: { const: 'user.created' },
                    shape: { deprecated: true, type: ['object', 'null'], oneOf: [circle, square] },
                  },
                },
                { type: 'object', properties: { event: { const: 'user.deleted' } } },
              ],
            },
          ],
        },
      }),
    );
    const spec = await parseSpec(file);
    for (const m of spec.models) expect(m.fields.length, m.name).toBeGreaterThan(0);
    expect(shapes(spec.models)).toMatchInlineSnapshot(`
      {
        "Event": {
          "deprecated": undefined,
          "fields": [
            "id",
          ],
        },
        "SquareUserCreatedShape": {
          "deprecated": true,
          "fields": [
            "kind",
            "side",
          ],
        },
        "UserCreated": {
          "deprecated": undefined,
          "fields": [
            "id",
            "event",
            "shape",
          ],
        },
        "UserCreatedShape": {
          "deprecated": undefined,
          "fields": [
            "kind",
            "r",
          ],
        },
        "UserDeleted": {
          "deprecated": undefined,
          "fields": [
            "id",
            "event",
          ],
        },
      }
    `);
  });

  it('collapses a nullable wrapper whose one branch has its own nested union, and never a two-variant one', async () => {
    const circle = obj({ properties: { kind: { const: 'circle' }, r: { type: 'number' } } });
    const square = obj({ deprecated: true, properties: { kind: { const: 'square' }, side: { type: 'number' } } });
    // One object branch carrying an `anyOf` of constraint sets beside its
    // properties: the union collapses at the wrapper level, and the branch's
    // own `anyOf` is the branch's business, so the model takes the wrapper's
    // flag exactly as a plain object branch would.
    const constrained = {
      deprecated: true,
      oneOf: [obj({ anyOf: [{ required: ['k'] }, { maxProperties: 1 }] }), { type: 'null' }],
    };
    // One object branch whose property is itself a union of objects: the
    // branch model takes the wrapper's flag, and the property's variants are
    // built as written, with their fields and their own flags.
    const nested = {
      deprecated: true,
      oneOf: [obj({ properties: { shape: { oneOf: [circle, square] } } }), { type: 'null' }],
    };
    // Two non-null variants beside `null`: not a nullable wrapper, so nothing
    // collapses, every variant keeps its fields, and none takes the wrapper's flag.
    const twoVariants = { deprecated: true, oneOf: [circle, square, { type: 'null' }] };
    const body = (schema: unknown, operationId: string) => ({
      post: {
        operationId,
        requestBody: { content: { 'application/json': { schema } } },
        responses: { '201': { description: 'created' } },
      },
    });
    const file = await writeSpec(
      'nested-union.json',
      specDoc(
        { Thing: { type: 'object', properties: { constrained, nested, two_variants: twoVariants } } },
        {
          '/constrained': body(constrained, 'createConstrained'),
          '/nested': body(nested, 'createNested'),
          '/two': body(twoVariants, 'createTwo'),
        },
      ),
    );
    const spec = await parseSpec(file);
    for (const m of spec.models) expect(m.fields.length, m.name).toBeGreaterThan(0);
    expect(shapes(spec.models)).toMatchInlineSnapshot(`
      {
        "CircleCreateTwoRequest": {
          "deprecated": undefined,
          "fields": [
            "kind",
            "r",
          ],
        },
        "CreateConstrainedRequest": {
          "deprecated": true,
          "fields": [
            "k",
          ],
        },
        "CreateNestedRequest": {
          "deprecated": true,
          "fields": [
            "shape",
          ],
        },
        "CreateNestedRequestShape": {
          "deprecated": undefined,
          "fields": [
            "kind",
            "r",
          ],
        },
        "SquareCreateNestedRequestShape": {
          "deprecated": true,
          "fields": [
            "kind",
            "side",
          ],
        },
        "SquareCreateTwoRequest": {
          "deprecated": true,
          "fields": [
            "kind",
            "side",
          ],
        },
        "SquareThingNestedShape": {
          "deprecated": true,
          "fields": [
            "kind",
            "side",
          ],
        },
        "SquareThingTwoVariant": {
          "deprecated": true,
          "fields": [
            "kind",
            "side",
          ],
        },
        "Thing": {
          "deprecated": undefined,
          "fields": [
            "constrained",
            "nested",
            "two_variants",
          ],
        },
        "ThingConstrained": {
          "deprecated": true,
          "fields": [
            "k",
          ],
        },
        "ThingNested": {
          "deprecated": true,
          "fields": [
            "shape",
          ],
        },
        "ThingNestedShape": {
          "deprecated": undefined,
          "fields": [
            "kind",
            "r",
          ],
        },
        "ThingTwoVariant": {
          "deprecated": undefined,
          "fields": [
            "kind",
            "r",
          ],
        },
      }
    `);
    // Each field reads the wrapper's keyword, whether or not its union collapsed.
    const thing = spec.models.find((m) => m.name === 'Thing')!;
    expect(thing.fields.map((f) => [f.name, f.deprecated])).toEqual([
      ['constrained', true],
      ['nested', true],
      ['two_variants', true],
    ]);
  });
});
