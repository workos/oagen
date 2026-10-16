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
});
