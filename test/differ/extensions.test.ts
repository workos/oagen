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
import { describe, it, expect } from 'vitest';
import { diffSpecs } from '../../src/differ/diff.js';
import { extensionsShift } from '../../src/differ/classify.js';
import { documentTypes, sameShape } from '../../src/differ/shapes.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
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
});
