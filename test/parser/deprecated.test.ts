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
import {
  collapseJsonSuffixModels,
  mergeInlineResponseModels,
  mergeFieldInlineModels,
} from '../../src/parser/normalize-inline-models.js';
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
      expect(merged.map((m) => m.name)).toEqual(['Widget', 'Gadget', 'GadgetJson']);
      expect(merged.find((m) => m.name === 'Widget')).not.toHaveProperty('deprecated');
      expect(merged.find((m) => m.name === 'Gadget')).toMatchObject({ deprecated: true });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('inline-model merges – deprecated', () => {
  const str = { kind: 'primitive', type: 'string' } as const;
  /** A `Widget` inline model with one string field `k`. */
  const widget = (deprecated: boolean, required: boolean): Model => ({
    name: 'Widget',
    fields: [{ name: 'k', type: str, required }],
    ...(deprecated ? { deprecated: true } : {}),
  });
  const describeModel = (m: Model | undefined) => m && { deprecated: m.deprecated, kRequired: m.fields[0]?.required };
  const swapWarnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter(([message]) => String(message).includes('both deprecated and live'));

  it('does not swap in a live copy whose requiredness differs (the reviewer’s case)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Deprecated with optional `k`, then live with required `k`: not
      // interchangeable, so the merge keeps its usual first definition — the
      // deprecated response never starts promising `k`.
      const first = mergeInlineResponseModels([], [widget(true, false), widget(false, true)]);
      expect(first.map(describeModel)).toEqual([{ deprecated: true, kRequired: false }]);
      // The other order keeps the live, required one for the same reason.
      const second = mergeInlineResponseModels([], [widget(false, true), widget(true, false)]);
      expect(second.map(describeModel)).toEqual([{ deprecated: undefined, kRequired: true }]);
      // And an existing inline model is not replaced by a differing live copy.
      const kept = mergeFieldInlineModels([widget(true, false)], [widget(false, true)], new Set());
      expect(kept.map(describeModel)).toEqual([{ deprecated: true, kRequired: false }]);
      expect(swapWarnings(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the live copy when the two are identical but for the flag, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = mergeInlineResponseModels([], [widget(true, true), widget(false, true)]);
      expect(response.map(describeModel)).toEqual([{ deprecated: undefined, kRequired: true }]);
      const field = mergeFieldInlineModels([widget(true, true)], [widget(false, true)], new Set());
      expect(field.map(describeModel)).toEqual([{ deprecated: undefined, kRequired: true }]);
      expect(swapWarnings(warn)).toHaveLength(2);
      // A component's own flag is authoritative: it is never replaced.
      const component = mergeFieldInlineModels([widget(true, true)], [widget(false, true)], new Set(['Widget']));
      expect(component.map(describeModel)).toEqual([{ deprecated: true, kRequired: true }]);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a component’s own flag when a larger inline response replaces its fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const component = (deprecated: boolean): Model => widget(deprecated, true);
      /** The same `Widget`, as an inline response that adds a field. */
      const response = (deprecated: boolean): Model => ({
        ...widget(deprecated, true),
        fields: [...widget(deprecated, true).fields, { name: 'extra', type: str, required: false }],
      });
      const merge = (c: Model, r: Model) =>
        mergeInlineResponseModels([c], [r]).map((m) => ({
          name: m.name,
          deprecated: m.deprecated,
          hasKey: 'deprecated' in m,
          fields: m.fields.map((f) => f.name),
        }));

      // A live component takes the response's fields but stays live, the key
      // absent; a deprecated one keeps its flag under a live response's fields.
      expect(merge(component(false), response(true))).toEqual([
        { name: 'Widget', deprecated: undefined, hasKey: false, fields: ['k', 'extra'] },
      ]);
      expect(merge(component(true), response(false))).toEqual([
        { name: 'Widget', deprecated: true, hasKey: true, fields: ['k', 'extra'] },
      ]);
      // Agreeing flags fold exactly as before.
      expect(merge(component(true), response(true))).toEqual([
        { name: 'Widget', deprecated: true, hasKey: true, fields: ['k', 'extra'] },
      ]);
      expect(merge(component(false), response(false))).toEqual([
        { name: 'Widget', deprecated: undefined, hasKey: false, fields: ['k', 'extra'] },
      ]);
      // Only the two disagreeing merges say so.
      const flagWarnings = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes("component's flag"));
      expect(flagWarnings).toEqual([
        '[oagen] Warning: Inline model "Widget" is deprecated but component schema "Widget" is live — keeping the component\'s flag',
        '[oagen] Warning: Inline model "Widget" is live but component schema "Widget" is deprecated — keeping the component\'s flag',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a component’s own description and link when a larger inline response replaces its fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const docs = (description: string | undefined, url?: string): Partial<Model> => ({
        description,
        ...(url ? { externalDocs: { url } } : {}),
      });
      const component = (d: Partial<Model>): Model => ({ ...widget(false, true), ...d });
      /** The same `Widget`, as an inline response that adds a field. */
      const response = (d: Partial<Model>): Model => ({
        ...widget(false, true),
        fields: [...widget(false, true).fields, { name: 'extra', type: str, required: false }],
        ...d,
      });
      const merge = (c: Model, r: Model) =>
        mergeInlineResponseModels([c], [r]).map((m) => ({
          description: m.description,
          externalDocs: m.externalDocs,
          hasLink: 'externalDocs' in m,
          fields: m.fields.map((f) => f.name),
        }));
      const legacy = docs('Legacy widget.', 'https://example.com/legacy');

      // The component's documentation stays with its name; only the fields
      // are the response's.
      expect(merge(component(docs('A widget.', 'https://example.com/widget')), response(legacy))).toEqual([
        {
          description: 'A widget.',
          externalDocs: { url: 'https://example.com/widget' },
          hasLink: true,
          fields: ['k', 'extra'],
        },
      ]);
      // A component without them adopts the response's.
      expect(merge(component(docs(undefined)), response(legacy))).toEqual([
        {
          description: 'Legacy widget.',
          externalDocs: { url: 'https://example.com/legacy' },
          hasLink: true,
          fields: ['k', 'extra'],
        },
      ]);
      // Each fills in on its own: a described component without a link takes
      // the response's link and keeps its description.
      expect(merge(component(docs('A widget.')), response(legacy))).toEqual([
        {
          description: 'A widget.',
          externalDocs: { url: 'https://example.com/legacy' },
          hasLink: true,
          fields: ['k', 'extra'],
        },
      ]);
      // Neither documented: the link key stays absent.
      expect(merge(component(docs(undefined)), response(docs(undefined)))).toEqual([
        { description: undefined, externalDocs: undefined, hasLink: false, fields: ['k', 'extra'] },
      ]);
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

  it('discards every null variant, however many and however spelled, before deciding a union collapses', async () => {
    const circle = obj({ properties: { kind: { const: 'circle' }, r: { type: 'number' } } });
    const square = obj({ deprecated: true, properties: { kind: { const: 'square' }, side: { type: 'number' } } });
    const nulls = [{ type: 'null' }, { type: ['null'] }];
    // One non-null variant beside two `null` spellings: a nullable wrapper,
    // so the model is built from the object with the wrapper's flag — in
    // both union keywords. (The `anyOf` spelling is exercised on the
    // property: the request-body path materializes `oneOf` variants only,
    // as it does on main, so an `anyOf` body has no inline model there.)
    const oneOfTwoNulls = { deprecated: true, oneOf: [obj(), ...nulls] };
    const anyOfTwoNulls = { deprecated: true, anyOf: [obj(), ...nulls] };
    // Two non-null variants beside two `null`s: not a nullable wrapper, so
    // nothing collapses and every variant keeps its fields and its own flag.
    const twoOfTwoNulls = { deprecated: true, oneOf: [circle, square, ...nulls] };
    const body = (schema: unknown, operationId: string) => ({
      post: {
        operationId,
        requestBody: { content: { 'application/json': { schema } } },
        responses: { '201': { description: 'created' } },
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const file = await writeSpec(
        'multi-null.json',
        specDoc(
          {
            Thing: { type: 'object', properties: { one_of: oneOfTwoNulls, any_of: anyOfTwoNulls, two: twoOfTwoNulls } },
          },
          {
            '/one': body(oneOfTwoNulls, 'createOne'),
            '/two': body(twoOfTwoNulls, 'createTwo'),
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
          "CreateOneRequest": {
            "deprecated": true,
            "fields": [
              "k",
            ],
          },
          "SquareCreateTwoRequest": {
            "deprecated": true,
            "fields": [
              "kind",
              "side",
            ],
          },
          "SquareThingTwo": {
            "deprecated": true,
            "fields": [
              "kind",
              "side",
            ],
          },
          "Thing": {
            "deprecated": undefined,
            "fields": [
              "one_of",
              "any_of",
              "two",
            ],
          },
          "ThingAnyOf": {
            "deprecated": true,
            "fields": [
              "k",
            ],
          },
          "ThingOneOf": {
            "deprecated": true,
            "fields": [
              "k",
            ],
          },
          "ThingTwo": {
            "deprecated": undefined,
            "fields": [
              "kind",
              "r",
            ],
          },
        }
      `);
      // Every model the IR references exists under the name the type side chose.
      expect(warn.mock.calls.filter(([message]) => String(message).includes('Unresolved model reference'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('never lets a deprecated list-envelope companion deprecate the shared model, in either document order', async () => {
    const listMetadata = (extra: Record<string, unknown> = {}) => ({
      type: 'object',
      properties: { before: { type: ['string', 'null'] }, after: { type: ['string', 'null'] } },
      ...extra,
    });
    const envelope = (meta: Record<string, unknown>) => ({
      allOf: [
        { type: 'object', properties: { object: { type: 'string', const: 'list' }, list_metadata: meta } },
        { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/User' } } } },
      ],
    });
    const listOp = (operationId: string, schema: unknown) => ({
      get: {
        operationId,
        parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
      },
    });
    const legacy = listOp('listLegacyUsers', envelope(listMetadata({ deprecated: true })));
    const live = listOp('listUsers', envelope(listMetadata()));
    const User = { type: 'object', properties: { id: { type: 'string' } } };

    const results = [];
    for (const [label, paths] of [
      ['legacy-first', { '/legacy-users': legacy, '/users': live }],
      ['live-first', { '/users': live, '/legacy-users': legacy }],
    ] as const) {
      const spec = await parseSpec(await writeSpec(`${label}.json`, specDoc({ User }, paths)));
      const ops = Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));
      const metaRef = (name: string) =>
        ops[name]?.pagination?.envelopeFields?.find((f) => f.name === 'list_metadata')?.type;
      // The live operation shares the bare name; the deprecated copy keeps its
      // operation-qualified name and its flag.
      expect(metaRef('listUsers'), label).toEqual({ kind: 'model', name: 'ListMetadata' });
      expect(metaRef('listLegacyUsers'), label).toEqual({ kind: 'model', name: 'ListLegacyUsersListMetadata' });
      results.push(flags(spec.models));
    }
    // Both orders yield the same IR.
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchInlineSnapshot(`
      {
        "ListLegacyUsersListMetadata": true,
        "ListMetadata": undefined,
        "User": undefined,
      }
    `);
  });

  it('never lets a larger inline response change a component’s flag, in either document order', async () => {
    const Widget = (extra: Record<string, unknown> = {}) => ({
      type: 'object',
      properties: { object: { type: 'string', const: 'widget' }, k: { type: 'string' } },
      ...extra,
    });
    const getOp = (operationId: string, schema: unknown) => ({
      get: { operationId, responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } } },
    });
    const fromComponent = getOp('getWidget', { $ref: '#/components/schemas/Widget' });
    // An inline response pinned to the same `object` const, so it is named
    // `Widget` too, with one field the component lacks.
    const largerInline = (extra: Record<string, unknown>) =>
      getOp('getLegacyWidget', { ...Widget(extra), properties: { ...Widget().properties, extra: { type: 'string' } } });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const [componentFlag, responseFlag] of [
        [false, true],
        [true, false],
      ] as const) {
        const component = Widget(componentFlag ? { deprecated: true } : {});
        const inline = largerInline(responseFlag ? { deprecated: true } : {});
        const results = [];
        for (const [order, paths] of [
          ['component-first', { '/widget': fromComponent, '/legacy-widget': inline }],
          ['inline-first', { '/legacy-widget': inline, '/widget': fromComponent }],
        ] as const) {
          const label = `component ${componentFlag ? 'deprecated' : 'live'}, ${order}`;
          warn.mockClear();
          const spec = await parseSpec(await writeSpec(`${order}.json`, specDoc({ Widget: component }, paths)));
          const warnings = warn.mock.calls.map(([m]) => String(m));
          // The component keeps its own flag and its own fields; the response,
          // which disagrees on the flag, takes an operation-qualified name of
          // its own (issue #260), and both operations resolve — nothing dangles.
          expect(shapes(spec.models), label).toEqual({
            Widget: { deprecated: componentFlag ? true : undefined, fields: ['object', 'k'] },
            GetLegacyWidgetWidget: { deprecated: responseFlag ? true : undefined, fields: ['object', 'k', 'extra'] },
          });
          const ops = Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));
          expect(ops.getWidget?.response, label).toEqual({ kind: 'model', name: 'Widget' });
          expect(ops.getLegacyWidget?.response, label).toEqual({ kind: 'model', name: 'GetLegacyWidgetWidget' });
          expect(
            warnings.filter((w) => w.includes('Unresolved model reference')),
            label,
          ).toEqual([]);
          expect(
            warnings.filter((w) => w.includes("keeping the component's flag")),
            label,
          ).toHaveLength(0);
          results.push(flags(spec.models));
        }
        expect(results[0]).toEqual(results[1]);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a component’s own description and link under a larger inline response’s fields, in either document order', async () => {
    const widget = (extra: Record<string, unknown> = {}) => ({
      type: 'object',
      properties: { object: { type: 'string', const: 'widget' }, k: { type: 'string' } },
      ...extra,
    });
    const getOp = (operationId: string, schema: unknown) => ({
      get: { operationId, responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } } },
    });
    const fromComponent = getOp('getWidget', { $ref: '#/components/schemas/Widget' });
    const legacyDocs = { description: 'Legacy widget.', externalDocs: { url: 'https://example.com/legacy' } };
    // An inline response pinned to the same `object` const, documented in its
    // own words, with one field the component lacks.
    const inline = getOp('getLegacyWidget', {
      ...widget(legacyDocs),
      properties: { ...widget().properties, extra: { type: 'string' } },
    });
    const widgetDocs = { description: 'A widget.', externalDocs: { url: 'https://example.com/widget' } };
    const docsOf = (m: Model | undefined) =>
      m && { description: m.description, externalDocs: m.externalDocs, fields: m.fields.map((f) => f.name) };
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['documented component keeps its own', widgetDocs, widgetDocs],
      ['undocumented component adopts the response’s', {}, legacyDocs],
    ];

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const [label, componentDocs, expected] of cases) {
        const results = [];
        for (const [order, paths] of [
          ['component-first', { '/widget': fromComponent, '/legacy-widget': inline }],
          ['inline-first', { '/legacy-widget': inline, '/widget': fromComponent }],
        ] as const) {
          const where = `${label}, ${order}`;
          warn.mockClear();
          const file = await writeSpec(`${order}.json`, specDoc({ Widget: widget(componentDocs) }, paths));
          const spec = await parseSpec(file);
          const warnings = warn.mock.calls.map(([m]) => String(m));
          expect(docsOf(spec.models.find((m) => m.name === 'Widget')), where).toEqual({
            ...expected,
            fields: ['object', 'k', 'extra'],
          });
          const ops = Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));
          expect(ops.getWidget?.response, where).toEqual({ kind: 'model', name: 'Widget' });
          expect(ops.getLegacyWidget?.response, where).toEqual({ kind: 'model', name: 'Widget' });
          expect(
            warnings.filter((w) => w.includes('Unresolved model reference')),
            where,
          ).toEqual([]);
          results.push(spec.models.map(docsOf));
        }
        expect(results[0], label).toEqual(results[1]);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('never lets a deprecated header model share a live header model’s name, in either document order', async () => {
    const withHeader = (operationId: string, meta: Record<string, unknown>) => ({
      get: {
        operationId,
        tags: ['Users'],
        responses: { '200': { description: 'ok', headers: { 'X-Meta': { schema: meta } } } },
      },
    });
    const meta = (extra: Record<string, unknown> = {}) => ({
      type: 'object',
      properties: { etag: { type: 'string' } },
      ...extra,
    });
    const legacy = withHeader('listLegacyUsers', meta({ deprecated: true }));
    const live = withHeader('listUsers', meta());

    for (const [label, paths] of [
      ['legacy-first', { '/legacy-users': legacy, '/users': live }],
      ['live-first', { '/users': live, '/legacy-users': legacy }],
    ] as const) {
      const spec = await parseSpec(await writeSpec(`header-${label}.json`, specDoc({}, paths)));
      const ops = Object.fromEntries(spec.services.flatMap((s) => s.operations).map((op) => [op.name, op]));
      const headerModel = (name: string) => {
        const ref = ops[name]?.responseHeaders?.[0]?.type;
        expect(ref?.kind, `${label}: ${name}`).toBe('model');
        return spec.models.find((m) => m.name === (ref as { name: string }).name)!;
      };
      // The registry treats the flag as part of the shape, so the two headers
      // never share one model: the live operation's is live, the deprecated
      // operation's is deprecated, whichever came first.
      expect(headerModel('listUsers').deprecated, label).toBeUndefined();
      expect(headerModel('listLegacyUsers').deprecated, label).toBe(true);
      expect(headerModel('listUsers').name, label).not.toBe(headerModel('listLegacyUsers').name);
      expect(
        headerModel('listUsers').fields.map((f) => f.name),
        label,
      ).toEqual(['etag']);
      expect(
        headerModel('listLegacyUsers').fields.map((f) => f.name),
        label,
      ).toEqual(['etag']);
    }
  });

  it('never flips a shared inline response model’s requiredness when only deprecation differs', async () => {
    const response = (operationId: string, schema: unknown) => ({
      get: { operationId, responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } } },
    });
    const widget = (over: Record<string, unknown>) => ({
      type: 'object',
      properties: { object: { const: 'widget' }, k: { type: 'string' } },
      ...over,
    });
    const describeWidget = (spec: Awaited<ReturnType<typeof parseSpec>>) => {
      const models = spec.models.filter((m) => m.name === 'Widget');
      return models.map((m) => ({
        deprecated: m.deprecated,
        kRequired: m.fields.find((f) => f.name === 'k')?.required,
      }));
    };
    const parse = async (label: string, paths: Record<string, unknown>) =>
      describeWidget(await parseSpec(await writeSpec(`${label}.json`, specDoc({}, paths))));

    // The reviewer's case: deprecated with optional `k`, live with required
    // `k`, both named `Widget` from the shared const. Not interchangeable, so
    // the live definition owns `Widget` in either order and the deprecated
    // one is qualified by its operation (issue #260) — the deprecated
    // endpoint never starts promising `k`.
    const legacyOptional = response('getLegacy', widget({ deprecated: true }));
    const liveRequired = response('getLive', widget({ required: ['k'] }));
    expect(await parse('differ-legacy-first', { '/legacy': legacyOptional, '/live': liveRequired })).toEqual([
      { deprecated: undefined, kRequired: true },
    ]);
    expect(await parse('differ-live-first', { '/live': liveRequired, '/legacy': legacyOptional })).toEqual([
      { deprecated: undefined, kRequired: true },
    ]);

    // Identical but for the flag: the live definition wins in either order.
    const legacyRequired = response('getLegacy', widget({ deprecated: true, required: ['k'] }));
    expect(await parse('same-legacy-first', { '/legacy': legacyRequired, '/live': liveRequired })).toEqual([
      { deprecated: undefined, kRequired: true },
    ]);
    expect(await parse('same-live-first', { '/live': liveRequired, '/legacy': legacyRequired })).toEqual([
      { deprecated: undefined, kRequired: true },
    ]);
  });
});
