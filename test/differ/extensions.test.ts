/**
 * Issue #352: `extensions` — the `x-*` keys an operation, model, field or
 * enum was built with — are not shape. The differ reports a change to them
 * as additive (`extensionsChanged: true` on the owning `-modified` change
 * with `oldExtensions`/`newExtensions` beside it, a
 * `field-extensions-changed` entry for a field), still reported when it is
 * the only change, mirrored into `behaviorChanges` as `extensions-changed`,
 * and never as a type change; a body comparison that reads a model through
 * to its shape ignores them, as it ignores a description.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { extensionsShift } from '../../src/differ/classify.js';
import { documentTypes, sameShape } from '../../src/differ/shapes.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, Enum, Extensions, Model, Operation } from '../../src/ir/types.js';

const pet = (extensions?: Extensions, nameExtensions?: Extensions): Model => ({
  name: 'Pet',
  fields: [
    {
      name: 'name',
      type: { kind: 'primitive', type: 'string' },
      required: true,
      ...(nameExtensions ? { extensions: nameExtensions } : {}),
    },
    { name: 'status', type: { kind: 'enum', name: 'PetStatus' }, required: false },
  ],
  ...(extensions ? { extensions } : {}),
});

const petStatus = (extensions?: Extensions): Enum => ({
  name: 'PetStatus',
  values: [
    { name: 'AVAILABLE', value: 'available' },
    { name: 'SOLD', value: 'sold' },
  ],
  ...(extensions ? { extensions } : {}),
});

const importPet = (extensions?: Extensions): Operation => ({
  name: 'importPet',
  httpMethod: 'post',
  path: '/pets/import',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  requestBody: { kind: 'model', name: 'Pet' },
  response: { kind: 'primitive', type: 'unknown' },
  errors: [],
  injectIdempotencyKey: false,
  ...(extensions ? { extensions } : {}),
});

const spec = (
  parts: { model?: Model; enum?: Enum; operation?: Operation; models?: Model[] } = {},
  version = '1',
): ApiSpec => ({
  name: 'Pets',
  version,
  baseUrl: 'https://api.example.com',
  models: parts.models ?? [parts.model ?? pet()],
  enums: [parts.enum ?? petStatus()],
  services: [{ name: 'Pets', operations: [parts.operation ?? importPet()] }],
  sdk: defaultSdkBehavior(),
});

const SINCE = { 'x-since': '1.2.0' };
const LATER = { 'x-since': '1.3.0', 'x-idempotent': true };

describe('extension changes in the differ (issue #352)', () => {
  it('reports a model’s extensions changing as additive, alone, with both sides, and mirrors it', () => {
    const report = diffSpecs(spec({ model: pet(SINCE) }), spec({ model: pet(LATER) }, '2'));
    expect(report.changes).toEqual([
      {
        kind: 'model-modified',
        name: 'Pet',
        fieldChanges: [],
        deprecatedChanged: false,
        extensionsChanged: true,
        oldExtensions: SINCE,
        newExtensions: LATER,
        classification: 'additive',
      },
    ]);
    expect(report.behaviorChanges).toEqual([
      {
        kind: 'extensions-changed',
        node: 'model',
        modelName: 'Pet',
        oldExtensions: SINCE,
        newExtensions: LATER,
        classification: 'additive',
      },
    ]);
    expect(report.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 1 });
  });

  it('carries only the side a node has extensions on: appearing and disappearing', () => {
    const appeared = diffSpecs(spec(), spec({ model: pet(SINCE) }));
    expect(appeared.changes).toEqual([
      expect.objectContaining({ kind: 'model-modified', extensionsChanged: true, newExtensions: SINCE }),
    ]);
    expect(appeared.changes[0]).not.toHaveProperty('oldExtensions');
    expect(appeared.behaviorChanges[0]).not.toHaveProperty('oldExtensions');

    const vanished = diffSpecs(spec({ model: pet(SINCE) }), spec());
    expect(vanished.changes).toEqual([
      expect.objectContaining({ kind: 'model-modified', extensionsChanged: true, oldExtensions: SINCE }),
    ]);
    expect(vanished.changes[0]).not.toHaveProperty('newExtensions');
    expect(vanished.behaviorChanges[0]).not.toHaveProperty('newExtensions');
  });

  it('reports a field’s extensions changing as a field-extensions-changed entry, never a type change', () => {
    const report = diffSpecs(spec({ model: pet(undefined, SINCE) }), spec({ model: pet(undefined, LATER) }));
    expect(report.changes).toEqual([
      {
        kind: 'model-modified',
        name: 'Pet',
        fieldChanges: [
          {
            kind: 'field-extensions-changed',
            fieldName: 'name',
            classification: 'additive',
            oldExtensions: SINCE,
            newExtensions: LATER,
          },
        ],
        deprecatedChanged: false,
        classification: 'additive',
      },
    ]);
    expect(report.behaviorChanges).toEqual([
      {
        kind: 'extensions-changed',
        node: 'field',
        modelName: 'Pet',
        fieldName: 'name',
        oldExtensions: SINCE,
        newExtensions: LATER,
        classification: 'additive',
      },
    ]);
  });

  it('reports an enum’s extensions changing as additive, alone, and mirrors it', () => {
    const report = diffSpecs(spec({ enum: petStatus(SINCE) }), spec({ enum: petStatus(LATER) }));
    expect(report.changes).toEqual([
      {
        kind: 'enum-modified',
        name: 'PetStatus',
        valueChanges: [],
        deprecatedChanged: false,
        extensionsChanged: true,
        oldExtensions: SINCE,
        newExtensions: LATER,
        classification: 'additive',
      },
    ]);
    expect(report.behaviorChanges).toEqual([
      {
        kind: 'extensions-changed',
        node: 'enum',
        enumName: 'PetStatus',
        oldExtensions: SINCE,
        newExtensions: LATER,
        classification: 'additive',
      },
    ]);
  });

  it('reports an operation’s extensions changing as additive, alone, and mirrors it', () => {
    const report = diffSpecs(spec({ operation: importPet(SINCE) }), spec({ operation: importPet(LATER) }));
    expect(report.changes).toEqual([
      expect.objectContaining({
        kind: 'operation-modified',
        serviceName: 'Pets',
        operationName: 'importPet',
        paramChanges: [],
        requestBodyChanged: false,
        responseChanged: false,
        deprecatedChanged: false,
        extensionsChanged: true,
        oldExtensions: SINCE,
        newExtensions: LATER,
        classification: 'additive',
      }),
    ]);
    expect(report.behaviorChanges).toEqual([
      {
        kind: 'extensions-changed',
        node: 'operation',
        serviceName: 'Pets',
        operationName: 'importPet',
        oldExtensions: SINCE,
        newExtensions: LATER,
        classification: 'additive',
      },
    ]);
    expect(report.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 1 });
  });

  it('keeps a breaking change breaking and reports the extension change beside it', () => {
    const retyped: Model = {
      ...pet(LATER),
      fields: [{ name: 'name', type: { kind: 'primitive', type: 'integer' }, required: true }],
    };
    const report = diffSpecs(spec({ model: pet(SINCE) }), spec({ model: retyped }));
    expect(report.changes).toEqual([
      expect.objectContaining({
        kind: 'model-modified',
        extensionsChanged: true,
        classification: 'breaking',
        fieldChanges: expect.arrayContaining([
          expect.objectContaining({ kind: 'field-type-changed', fieldName: 'name' }),
        ]),
      }),
    ]);
    expect(report.summary).toMatchObject({ breaking: 1, additive: 0, behaviorChanges: 1 });
  });

  it('compares deeply, key order aside, and reads an empty object as none: no change, no flag', () => {
    const a = { 'x-meta': { list: [1, 2], flag: true }, 'x-since': '1' };
    const b = { 'x-since': '1', 'x-meta': { flag: true, list: [1, 2] } };
    const same = diffSpecs(
      spec({ model: pet(a, a), enum: petStatus(a), operation: importPet(a) }),
      spec({ model: pet(b, b), enum: petStatus(b), operation: importPet(b) }),
    );
    expect(same.changes).toEqual([]);
    expect(same.behaviorChanges).toEqual([]);

    const empty = diffSpecs(spec(), spec({ model: pet({}, {}), enum: petStatus({}), operation: importPet({}) }));
    expect(empty.changes).toEqual([]);

    expect(extensionsShift({ extensions: a }, { extensions: b })).toBeUndefined();
    expect(extensionsShift({}, { extensions: {} })).toBeUndefined();
    expect(extensionsShift({ extensions: a }, {})).toEqual({ oldExtensions: a });
    expect(extensionsShift({}, { extensions: b })).toEqual({ newExtensions: b });
    expect(extensionsShift({ extensions: { 'x-a': [1] } }, { extensions: { 'x-a': [2] } })).toEqual({
      oldExtensions: { 'x-a': [1] },
      newExtensions: { 'x-a': [2] },
    });
  });

  it('leaves `extensionsChanged` off a change report that has no extension change', () => {
    const deprecated: Model = { ...pet(SINCE), deprecated: true };
    const report = diffSpecs(spec({ model: pet(SINCE) }), spec({ model: deprecated }));
    expect(report.changes).toEqual([
      expect.objectContaining({ kind: 'model-modified', deprecatedChanged: true, classification: 'additive' }),
    ]);
    expect(report.changes[0]).not.toHaveProperty('extensionsChanged');
    expect(report.behaviorChanges.map((c) => c.kind)).toEqual(['deprecated-changed']);
  });

  it('a body model read through to its shape is one shape whatever its extensions: a rename is not a retype', () => {
    const renamed: Model = { ...pet(LATER, LATER), name: 'CreatePetRequest' };
    const shapes = {
      old: documentTypes(spec({ model: pet(SINCE, SINCE) })),
      new: documentTypes(spec({ models: [renamed] })),
    };
    expect(sameShape({ kind: 'model', name: 'Pet' }, { kind: 'model', name: 'CreatePetRequest' }, shapes)).toBe(true);
    // A real shape difference still counts.
    const widened: Model = {
      ...renamed,
      fields: [...renamed.fields, { name: 'extra', type: { kind: 'primitive', type: 'string' }, required: false }],
    };
    const widenedShapes = { ...shapes, new: documentTypes(spec({ models: [widened] })) };
    expect(sameShape({ kind: 'model', name: 'Pet' }, { kind: 'model', name: 'CreatePetRequest' }, widenedShapes)).toBe(
      false,
    );
  });

  it('reports a list envelope field’s extensions changing, which no model carries (Greptile round 2)', () => {
    // A paginated response with an inline `data` array and a scalar
    // companion `has_more`: the field sits on `pagination.envelopeFields`
    // only, so `diffModels` cannot see it.
    const listPets = (since: string): Operation => ({
      name: 'listPets',
      httpMethod: 'get',
      path: '/pets',
      pathParams: [],
      queryParams: [{ name: 'after', type: { kind: 'primitive', type: 'string' }, required: false }],
      headerParams: [],
      response: { kind: 'array', items: { kind: 'model', name: 'Pet' } },
      errors: [],
      injectIdempotencyKey: false,
      pagination: {
        strategy: 'cursor',
        param: 'after',
        dataPath: 'data',
        itemType: { kind: 'model', name: 'Pet' },
        envelopeFields: [
          {
            name: 'has_more',
            type: { kind: 'primitive', type: 'boolean' },
            required: false,
            extensions: { 'x-since': since },
          },
          { name: 'total', type: { kind: 'primitive', type: 'integer' }, required: false },
        ],
      },
    });
    const report = diffSpecs(spec({ operation: listPets('1') }), spec({ operation: listPets('2') }));
    expect(report.changes).toEqual([
      expect.objectContaining({
        kind: 'operation-modified',
        operationName: 'listPets',
        envelopeFieldChanges: [
          {
            kind: 'field-extensions-changed',
            fieldName: 'has_more',
            classification: 'additive',
            oldExtensions: { 'x-since': '1' },
            newExtensions: { 'x-since': '2' },
          },
        ],
        classification: 'additive',
      }),
    ]);
    expect(report.changes[0]).not.toHaveProperty('extensionsChanged');
    expect(report.behaviorChanges).toEqual([
      {
        kind: 'extensions-changed',
        node: 'envelope-field',
        serviceName: 'Pets',
        operationName: 'listPets',
        fieldName: 'has_more',
        oldExtensions: { 'x-since': '1' },
        newExtensions: { 'x-since': '2' },
        classification: 'additive',
      },
    ]);
    expect(report.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 1 });
    // Unchanged envelope fields report nothing, and the key is absent then.
    const same = diffSpecs(spec({ operation: listPets('1') }), spec({ operation: listPets('1') }));
    expect(same.changes).toEqual([]);
  });
});

describe('every carrier of extensions has a differ comparison site (Greptile round 2)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function parseDocument(doc: unknown): Promise<ApiSpec> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-352-differ-'));
    dirs.push(dir);
    const file = path.join(dir, 'repro.json');
    await fs.writeFile(file, JSON.stringify(doc));
    return parseSpec(file);
  }

  /** A document declaring an `x-*` key on every node kind that carries extensions. */
  const DOCUMENT = {
    openapi: '3.1.0',
    info: { title: 'Pets', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          'x-operation': 1,
          parameters: [
            { name: 'after', in: 'query', schema: { type: 'string' } },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], 'x-lifted-enum': 1 } },
          ],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
                      has_more: { type: 'boolean', 'x-envelope-scalar': 1 },
                      list_metadata: {
                        type: 'object',
                        'x-companion': 1,
                        properties: { after: { type: 'string', 'x-companion-field': 1 } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Pet: {
          type: 'object',
          'x-model': 1,
          properties: {
            name: { type: 'string', 'x-field': 1 },
            species: { $ref: '#/components/schemas/Species' },
          },
        },
        Species: { type: 'string', enum: ['cat', 'dog'], 'x-enum': 1 },
      },
    },
  };

  type Path = Array<string | number>;

  /** The path of every object in the IR that has an `extensions` key, in traversal order. */
  function carriers(value: unknown, at: Path = [], out: Path[] = []): Path[] {
    if (Array.isArray(value)) {
      value.forEach((entry, i) => carriers(entry, [...at, i], out));
    } else if (value !== null && typeof value === 'object') {
      if (Object.hasOwn(value, 'extensions')) out.push(at);
      for (const [key, entry] of Object.entries(value)) if (key !== 'extensions') carriers(entry, [...at, key], out);
    }
    return out;
  }

  const nodeAt = (root: unknown, at: Path): { extensions?: Extensions } =>
    at.reduce<unknown>((value, key) => (value as Record<string | number, unknown>)[key], root) as {
      extensions?: Extensions;
    };

  it('reports a flip on every node the parsed IR carries extensions on, exactly once, as additive', async () => {
    const original = await parseDocument(DOCUMENT);
    const paths = carriers(original);
    const labels = paths.map((at) => at.join('.'));
    // The document reaches every carrier kind: the operation, a component
    // model and its field, a component enum, a lifted inline enum, the
    // envelope's scalar field, and the companion model with its field (the
    // companion is an envelope field too, carrying its schema's keys).
    const kindsReached = {
      operation: labels.some((l) => /^services\.\d+\.operations\.\d+$/.test(l)),
      model: labels.some((l) => /^models\.\d+$/.test(l)),
      field: labels.some((l) => /^models\.\d+\.fields\.\d+$/.test(l)),
      enum: labels.some((l) => /^enums\.\d+$/.test(l)),
      envelopeField: labels.some((l) => /^services\.\d+\.operations\.\d+\.pagination\.envelopeFields\.\d+$/.test(l)),
    };
    expect(kindsReached).toEqual({ operation: true, model: true, field: true, enum: true, envelopeField: true });
    expect(original.enums.map((e) => e.name).sort()).toEqual(['PetsSort', 'Species']);
    expect(original.services[0]!.operations[0]!.pagination?.envelopeFields?.map((f) => f.name)).toEqual([
      'has_more',
      'list_metadata',
    ]);

    for (const at of paths) {
      const label = at.join('.');
      const flipped = structuredClone(original);
      const node = nodeAt(flipped, at);
      node.extensions = { ...node.extensions, 'x-flipped': true };
      const report = diffSpecs(original, flipped);
      const mirrored = report.behaviorChanges.filter((c) => c.kind === 'extensions-changed');
      expect(mirrored, label).toHaveLength(1);
      expect(mirrored[0], label).toMatchObject({
        classification: 'additive',
        oldExtensions: nodeAt(original, at).extensions,
        newExtensions: node.extensions,
      });
      expect(
        report.changes.map((c) => c.classification),
        label,
      ).toEqual(['additive']);
      expect(report.summary, label).toMatchObject({ breaking: 0, additive: 1, behaviorChanges: 1 });
    }
    // Flipping nothing reports nothing.
    expect(diffSpecs(original, structuredClone(original)).changes).toEqual([]);
  });
});

describe('the keys a folded `…Json` model gives its base are compared (issue #426)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  /**
   * `createPet` takes `PetJson` and returns `Pet`; `PetJson` folds onto `Pet` with its link and
   * `x-since`. `chained` declares `PetJsonJson` after it, which `createPet` takes instead and
   * which alone carries `x-since`: it folds onto `PetJson`, which folds onto `Pet`.
   */
  async function parsePets(since: string, chained = false): Promise<ApiSpec> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-issue-426-differ-'));
    dirs.push(dir);
    const file = path.join(dir, 'pets.json');
    const pet = (properties: Record<string, unknown>) => ({ type: 'object', properties });
    await fs.writeFile(
      file,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Pets', version: '1' },
        paths: {
          '/pets': {
            post: {
              operationId: 'createPet',
              requestBody: {
                content: {
                  'application/json': {
                    schema: { $ref: `#/components/schemas/${chained ? 'PetJsonJson' : 'PetJson'}` },
                  },
                },
              },
              responses: {
                '200': {
                  description: 'ok',
                  content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Pet: pet({ name: { type: 'string' } }),
            PetJson: {
              ...pet({ name: { type: 'string' }, age: { type: 'integer' } }),
              externalDocs: { url: 'https://example.com/pets' },
              ...(chained ? {} : { 'x-since': since }),
            },
            ...(chained
              ? {
                  PetJsonJson: {
                    ...pet({ name: { type: 'string' }, age: { type: 'integer' }, tag: { type: 'string' } }),
                    'x-since': since,
                  },
                }
              : {}),
          },
        },
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      return await parseSpec(file);
    } finally {
      warn.mockRestore();
    }
  }

  it('reports `x-since` moving on `PetJson` as an additive change to `Pet`', async () => {
    const report = diffSpecs(await parsePets('1.2'), await parsePets('1.3'));
    expect(report.changes).toEqual([
      {
        kind: 'model-modified',
        name: 'Pet',
        fieldChanges: [],
        deprecatedChanged: false,
        extensionsChanged: true,
        oldExtensions: { 'x-since': '1.2' },
        newExtensions: { 'x-since': '1.3' },
        classification: 'additive',
      },
    ]);
    expect(report.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 1 });
  });

  it('reports `x-since` moving on the deepest of two chained folds, declared last, on `Pet` (Greptile)', async () => {
    const report = diffSpecs(await parsePets('1.2', true), await parsePets('1.3', true));
    expect(report.changes).toEqual([
      {
        kind: 'model-modified',
        name: 'Pet',
        fieldChanges: [],
        deprecatedChanged: false,
        extensionsChanged: true,
        oldExtensions: { 'x-since': '1.2' },
        newExtensions: { 'x-since': '1.3' },
        classification: 'additive',
      },
    ]);
  });
});
