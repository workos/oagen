/**
 * Issue #256: `diffSpecs` reports every IR node whose `deprecated` flag flips.
 *
 * Operation, parameter, model, field, enum and enum value each carry the flag.
 * A flip is reported on the owning `-modified` change (a flat `deprecatedChanged`
 * on the operation, model or enum; a `*-deprecated-changed` entry for a
 * parameter, field or enum value), is additive in either direction, is still
 * reported when it is the only change, and is mirrored into `behaviorChanges`.
 * Only `true` is deprecated: `false` and an absent key are the same thing.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffModels } from '../../src/differ/models.js';
import { diffOperations } from '../../src/differ/operations.js';
import { parseSpec } from '../../src/parser/parse.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Enum, Model, Operation, Parameter } from '../../src/ir/types.js';

const fixtures = path.resolve(import.meta.dirname, '../fixtures');

const pet: Model = {
  name: 'Pet',
  fields: [
    { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
    { name: 'status', type: { kind: 'enum', name: 'PetStatus' }, required: false },
  ],
};

const petStatus: Enum = {
  name: 'PetStatus',
  values: [
    { name: 'AVAILABLE', value: 'available' },
    { name: 'SOLD', value: 'sold' },
  ],
};

const verbose: Parameter = { name: 'verbose', type: { kind: 'primitive', type: 'boolean' }, required: false };

const getPet: Operation = {
  name: 'getPet',
  httpMethod: 'get',
  path: '/pets/{id}',
  pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
  queryParams: [verbose],
  headerParams: [{ name: 'X-Trace', type: { kind: 'primitive', type: 'string' }, required: false }],
  response: { kind: 'model', name: 'Pet' },
  errors: [],
  injectIdempotencyKey: false,
};

const v1: ApiSpec = {
  name: 'Pets',
  version: '1',
  baseUrl: 'https://api.example.com',
  models: [pet],
  enums: [petStatus],
  services: [{ name: 'Pets', operations: [getPet] }],
  sdk: defaultSdkBehavior(),
};

/** `pet` with its `status` field carrying `deprecated` as given (`undefined` drops the key). */
function withStatusFlag(deprecated: boolean | undefined): Model {
  return {
    ...pet,
    fields: pet.fields.map((f) => (f.name === 'status' ? { ...f, deprecated } : f)),
  };
}

/** `petStatus` with its `SOLD` value carrying `deprecated` as given. */
function withSoldFlag(deprecated: boolean | undefined): Enum {
  return {
    ...petStatus,
    values: petStatus.values.map((v) => (v.name === 'SOLD' ? { ...v, deprecated } : v)),
  };
}

const deprecatedOp: Operation = { ...getPet, deprecated: true };

describe('diffModels – deprecated (issue #256)', () => {
  it('reports a model becoming deprecated as its only change, additive', () => {
    const changes = diffModels([pet], [{ ...pet, deprecated: true }]);
    expect(changes).toEqual([
      { kind: 'model-modified', name: 'Pet', fieldChanges: [], deprecatedChanged: true, classification: 'additive' },
    ]);
  });

  it('reports a model no longer being deprecated, additive', () => {
    const changes = diffModels([{ ...pet, deprecated: true }], [pet]);
    expect(changes).toEqual([
      { kind: 'model-modified', name: 'Pet', fieldChanges: [], deprecatedChanged: true, classification: 'additive' },
    ]);
  });

  it('treats an explicit false and an absent key as the same: false → true is a change, undefined → false is not', () => {
    expect(diffModels([{ ...pet, deprecated: false }], [{ ...pet, deprecated: true }])).toMatchObject([
      { kind: 'model-modified', deprecatedChanged: true },
    ]);
    expect(diffModels([pet], [{ ...pet, deprecated: false }])).toHaveLength(0);
    expect(diffModels([{ ...pet, deprecated: false }], [pet])).toHaveLength(0);
    expect(diffModels([{ ...pet, deprecated: true }], [{ ...pet, deprecated: true }])).toHaveLength(0);
  });

  it('reports a field becoming deprecated as a field-deprecated-changed entry, additive', () => {
    const changes = diffModels([pet], [withStatusFlag(true)]);
    expect(changes).toEqual([
      {
        kind: 'model-modified',
        name: 'Pet',
        fieldChanges: [
          {
            kind: 'field-deprecated-changed',
            fieldName: 'status',
            classification: 'additive',
            details: 'live → deprecated',
          },
        ],
        deprecatedChanged: false,
        classification: 'additive',
      },
    ]);
  });

  it('reports a field no longer being deprecated with the direction in details', () => {
    const changes = diffModels([withStatusFlag(true)], [pet]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'model-modified') {
      expect(changes[0].fieldChanges).toEqual([
        {
          kind: 'field-deprecated-changed',
          fieldName: 'status',
          classification: 'additive',
          details: 'deprecated → live',
        },
      ]);
    }
  });

  it('treats a field flag of false as not deprecated', () => {
    expect(diffModels([withStatusFlag(false)], [withStatusFlag(true)])).toMatchObject([
      { fieldChanges: [{ kind: 'field-deprecated-changed', details: 'live → deprecated' }] },
    ]);
    expect(diffModels([pet], [withStatusFlag(false)])).toHaveLength(0);
    expect(diffModels([withStatusFlag(false)], [pet])).toHaveLength(0);
  });

  it('reports the model flag and a field flag flipping together on one change', () => {
    const changes = diffModels([pet], [{ ...withStatusFlag(true), deprecated: true }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'model-modified',
      deprecatedChanged: true,
      fieldChanges: [{ kind: 'field-deprecated-changed', fieldName: 'status' }],
      classification: 'additive',
    });
  });

  it('keeps the change breaking when a breaking field change rides along with the flag', () => {
    const narrowed: Model = { ...pet, deprecated: true, fields: pet.fields.filter((f) => f.name !== 'status') };
    const changes = diffModels([pet], [narrowed]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'model-modified',
      deprecatedChanged: true,
      fieldChanges: [{ kind: 'field-removed', fieldName: 'status', classification: 'breaking' }],
      classification: 'breaking',
    });
  });

  it('reports a deprecated field alongside a breaking type change on the same field', () => {
    const retyped: Model = {
      ...pet,
      fields: pet.fields.map((f) =>
        f.name === 'status' ? { ...f, type: { kind: 'primitive', type: 'string' }, deprecated: true } : f,
      ),
    };
    const changes = diffModels([pet], [retyped]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'model-modified') {
      expect(changes[0].classification).toBe('breaking');
      expect(changes[0].fieldChanges.map((fc) => fc.kind)).toEqual(['field-type-changed', 'field-deprecated-changed']);
    }
  });
});

describe('diffSpecs – enum deprecated (issue #256)', () => {
  const enumsOnly = (enums: Enum[]): ApiSpec => ({ ...v1, models: [], services: [], enums });

  it('reports an enum becoming deprecated as its only change, additive', () => {
    const diff = diffSpecs(enumsOnly([petStatus]), enumsOnly([{ ...petStatus, deprecated: true }]));
    expect(diff.changes).toEqual([
      {
        kind: 'enum-modified',
        name: 'PetStatus',
        valueChanges: [],
        deprecatedChanged: true,
        classification: 'additive',
      },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 1 });
  });

  it('reports an enum no longer being deprecated, additive', () => {
    const diff = diffSpecs(enumsOnly([{ ...petStatus, deprecated: true }]), enumsOnly([petStatus]));
    expect(diff.changes).toMatchObject([
      { kind: 'enum-modified', deprecatedChanged: true, classification: 'additive' },
    ]);
    expect(diff.behaviorChanges).toEqual([
      {
        kind: 'deprecated-changed',
        node: 'enum',
        enumName: 'PetStatus',
        oldDeprecated: true,
        newDeprecated: false,
        classification: 'additive',
      },
    ]);
  });

  it('treats an explicit false on an enum as not deprecated', () => {
    expect(
      diffSpecs(enumsOnly([{ ...petStatus, deprecated: false }]), enumsOnly([{ ...petStatus, deprecated: true }]))
        .changes,
    ).toMatchObject([{ kind: 'enum-modified', deprecatedChanged: true }]);
    expect(diffSpecs(enumsOnly([petStatus]), enumsOnly([{ ...petStatus, deprecated: false }])).changes).toEqual([]);
    expect(diffSpecs(enumsOnly([{ ...petStatus, deprecated: false }]), enumsOnly([petStatus])).changes).toEqual([]);
  });

  it('reports an enum value becoming deprecated as a value-deprecated-changed entry, additive', () => {
    const diff = diffSpecs(enumsOnly([petStatus]), enumsOnly([withSoldFlag(true)]));
    expect(diff.changes).toEqual([
      {
        kind: 'enum-modified',
        name: 'PetStatus',
        valueChanges: [
          {
            kind: 'value-deprecated-changed',
            valueName: 'SOLD',
            classification: 'additive',
            details: 'live → deprecated',
          },
        ],
        deprecatedChanged: false,
        classification: 'additive',
      },
    ]);
    expect(diff.behaviorChanges).toEqual([
      {
        kind: 'deprecated-changed',
        node: 'enum-value',
        enumName: 'PetStatus',
        valueName: 'SOLD',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
    ]);
  });

  it('reports an enum value no longer being deprecated with the direction in details', () => {
    const diff = diffSpecs(enumsOnly([withSoldFlag(true)]), enumsOnly([petStatus]));
    expect(diff.changes).toMatchObject([
      { kind: 'enum-modified', valueChanges: [{ kind: 'value-deprecated-changed', details: 'deprecated → live' }] },
    ]);
    expect(diff.behaviorChanges).toMatchObject([{ node: 'enum-value', oldDeprecated: true, newDeprecated: false }]);
  });

  it('treats an enum value flag of false as not deprecated', () => {
    expect(diffSpecs(enumsOnly([withSoldFlag(false)]), enumsOnly([withSoldFlag(true)])).changes).toMatchObject([
      { valueChanges: [{ kind: 'value-deprecated-changed' }] },
    ]);
    expect(diffSpecs(enumsOnly([petStatus]), enumsOnly([withSoldFlag(false)])).changes).toEqual([]);
  });

  it('keeps the change breaking when a value is removed alongside the flag', () => {
    const narrowed: Enum = { ...petStatus, deprecated: true, values: petStatus.values.slice(0, 1) };
    const diff = diffSpecs(enumsOnly([petStatus]), enumsOnly([narrowed]));
    expect(diff.changes).toMatchObject([
      {
        kind: 'enum-modified',
        deprecatedChanged: true,
        valueChanges: [{ kind: 'value-removed', valueName: 'SOLD', classification: 'breaking' }],
        classification: 'breaking',
      },
    ]);
    expect(diff.summary.breaking).toBe(1);
    expect(diff.summary.behaviorChanges).toBe(1);
  });
});

describe('diffOperations – deprecated (issue #256)', () => {
  it('reports an operation becoming deprecated as its only change, additive', () => {
    const changes = diffOperations('Pets', [getPet], [deprecatedOp]);
    expect(changes).toEqual([
      {
        kind: 'operation-modified',
        serviceName: 'Pets',
        operationName: 'getPet',
        paramChanges: [],
        responseChanged: false,
        requestBodyChanged: false,
        requestBodyRequiredChanged: false,
        httpMethodChanged: false,
        pathChanged: false,
        paginatedChanged: false,
        injectIdempotencyKeyChanged: false,
        errorsChanged: false,
        deprecatedChanged: true,
        classification: 'additive',
      },
    ]);
  });

  it('reports an operation no longer being deprecated, additive', () => {
    expect(diffOperations('Pets', [deprecatedOp], [getPet])).toMatchObject([
      { kind: 'operation-modified', deprecatedChanged: true, classification: 'additive' },
    ]);
  });

  it('treats an explicit false on an operation as not deprecated', () => {
    expect(diffOperations('Pets', [{ ...getPet, deprecated: false }], [deprecatedOp])).toMatchObject([
      { deprecatedChanged: true },
    ]);
    expect(diffOperations('Pets', [getPet], [{ ...getPet, deprecated: false }])).toHaveLength(0);
    expect(diffOperations('Pets', [{ ...getPet, deprecated: false }], [getPet])).toHaveLength(0);
    expect(diffOperations('Pets', [deprecatedOp], [deprecatedOp])).toHaveLength(0);
  });

  it('reports a query parameter becoming deprecated as a param-deprecated-changed entry with its location', () => {
    const modified: Operation = { ...getPet, queryParams: [{ ...verbose, deprecated: true }] };
    const changes = diffOperations('Pets', [getPet], [modified]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'operation-modified',
      deprecatedChanged: false,
      classification: 'additive',
    });
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].paramChanges).toEqual([
        {
          kind: 'param-deprecated-changed',
          paramName: 'verbose',
          classification: 'additive',
          paramLocation: 'query',
          details: 'live → deprecated',
        },
      ]);
    }
  });

  it('reports path and header parameters with their own locations', () => {
    const modified: Operation = {
      ...getPet,
      pathParams: getPet.pathParams.map((p) => ({ ...p, deprecated: true })),
      headerParams: getPet.headerParams.map((p) => ({ ...p, deprecated: true })),
    };
    const changes = diffOperations('Pets', [getPet], [modified]);
    expect(changes).toHaveLength(1);
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].paramChanges).toMatchObject([
        { kind: 'param-deprecated-changed', paramName: 'id', paramLocation: 'path' },
        { kind: 'param-deprecated-changed', paramName: 'X-Trace', paramLocation: 'header' },
      ]);
    }
  });

  it('reports a parameter no longer being deprecated with the direction in details', () => {
    const was: Operation = { ...getPet, queryParams: [{ ...verbose, deprecated: true }] };
    const changes = diffOperations('Pets', [was], [getPet]);
    expect(changes).toMatchObject([
      { paramChanges: [{ kind: 'param-deprecated-changed', paramName: 'verbose', details: 'deprecated → live' }] },
    ]);
  });

  it('treats a parameter flag of false as not deprecated', () => {
    const off: Operation = { ...getPet, queryParams: [{ ...verbose, deprecated: false }] };
    const on: Operation = { ...getPet, queryParams: [{ ...verbose, deprecated: true }] };
    expect(diffOperations('Pets', [off], [on])).toMatchObject([
      { paramChanges: [{ kind: 'param-deprecated-changed' }] },
    ]);
    expect(diffOperations('Pets', [getPet], [off])).toHaveLength(0);
    expect(diffOperations('Pets', [off], [getPet])).toHaveLength(0);
  });

  it('keeps the change breaking when the response changes alongside the flag', () => {
    const modified: Operation = { ...deprecatedOp, response: { kind: 'primitive', type: 'string' } };
    expect(diffOperations('Pets', [getPet], [modified])).toMatchObject([
      { kind: 'operation-modified', responseChanged: true, deprecatedChanged: true, classification: 'breaking' },
    ]);
  });

  it('keeps the change breaking when a required parameter is added alongside a parameter flag', () => {
    const modified: Operation = {
      ...getPet,
      queryParams: [
        { ...verbose, deprecated: true },
        { name: 'tenant', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    };
    const changes = diffOperations('Pets', [getPet], [modified]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ classification: 'breaking', deprecatedChanged: false });
    if (changes[0].kind === 'operation-modified') {
      expect(changes[0].paramChanges).toMatchObject([
        { kind: 'param-added', paramName: 'tenant', classification: 'breaking' },
        { kind: 'param-deprecated-changed', paramName: 'verbose', classification: 'additive' },
      ]);
    }
  });
});

describe('diffSpecs – deprecated behaviorChanges and summary (issue #256)', () => {
  /** Every node that carries the flag, flipped at once. */
  const allDeprecated: ApiSpec = {
    ...v1,
    models: [{ ...withStatusFlag(true), deprecated: true }],
    enums: [{ ...withSoldFlag(true), deprecated: true }],
    services: [{ name: 'Pets', operations: [{ ...deprecatedOp, queryParams: [{ ...verbose, deprecated: true }] }] }],
  };

  it('mirrors every flip into behaviorChanges, one entry per node, all additive', () => {
    const diff = diffSpecs(v1, allDeprecated);
    expect(diff.changes.map((c) => c.kind)).toEqual(['model-modified', 'enum-modified', 'operation-modified']);
    expect(diff.behaviorChanges).toEqual([
      {
        kind: 'deprecated-changed',
        node: 'model',
        modelName: 'Pet',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
      {
        kind: 'deprecated-changed',
        node: 'field',
        modelName: 'Pet',
        fieldName: 'status',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
      {
        kind: 'deprecated-changed',
        node: 'enum',
        enumName: 'PetStatus',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
      {
        kind: 'deprecated-changed',
        node: 'enum-value',
        enumName: 'PetStatus',
        valueName: 'SOLD',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
      {
        kind: 'deprecated-changed',
        node: 'operation',
        serviceName: 'Pets',
        operationName: 'getPet',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
      {
        kind: 'deprecated-changed',
        node: 'parameter',
        serviceName: 'Pets',
        operationName: 'getPet',
        paramName: 'verbose',
        paramLocation: 'query',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 3, breaking: 0, additive: 3, behaviorChanges: 6 });
  });

  it('reports the reverse direction with oldDeprecated true', () => {
    const diff = diffSpecs(allDeprecated, v1);
    expect(diff.changes.map((c) => c.classification)).toEqual(['additive', 'additive', 'additive']);
    expect(diff.behaviorChanges).toHaveLength(6);
    expect(diff.behaviorChanges.every((b) => b.kind === 'deprecated-changed')).toBe(true);
    for (const b of diff.behaviorChanges) {
      expect(b).toMatchObject({ oldDeprecated: true, newDeprecated: false, classification: 'additive' });
    }
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 3, breaking: 0, additive: 3, behaviorChanges: 6 });
  });

  it('counts a flag flip beside a breaking change once, as one breaking modified change', () => {
    const breaking: ApiSpec = {
      ...v1,
      models: [{ ...pet, deprecated: true, fields: pet.fields.filter((f) => f.name !== 'status') }],
    };
    const diff = diffSpecs(v1, breaking);
    expect(diff.changes).toMatchObject([
      { kind: 'model-modified', deprecatedChanged: true, classification: 'breaking' },
    ]);
    expect(diff.behaviorChanges).toMatchObject([{ kind: 'deprecated-changed', node: 'model', newDeprecated: true }]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 1, additive: 0, behaviorChanges: 1 });
  });

  it('keeps param-default-changed entries beside deprecated-changed ones', () => {
    const withDefault: ApiSpec = {
      ...v1,
      services: [{ name: 'Pets', operations: [{ ...getPet, queryParams: [{ ...verbose, default: false }] }] }],
    };
    const changed: ApiSpec = {
      ...v1,
      services: [
        {
          name: 'Pets',
          operations: [{ ...deprecatedOp, queryParams: [{ ...verbose, default: true, deprecated: true }] }],
        },
      ],
    };
    const diff = diffSpecs(withDefault, changed);
    expect(diff.behaviorChanges.map((b) => b.kind)).toEqual([
      'deprecated-changed',
      'param-default-changed',
      'deprecated-changed',
    ]);
    expect(diff.behaviorChanges).toMatchObject([
      { node: 'operation', operationName: 'getPet' },
      { kind: 'param-default-changed', paramName: 'verbose', oldDefault: 'false', newDefault: 'true' },
      { node: 'parameter', paramName: 'verbose', paramLocation: 'query' },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 1, additive: 0, behaviorChanges: 3 });
  });

  it('reports nothing for a spec diffed against itself', () => {
    const diff = diffSpecs(allDeprecated, allDeprecated);
    expect(diff.changes).toEqual([]);
    expect(diff.behaviorChanges).toEqual([]);
  });
});

describe('diffSpecs – end to end (issue #256 repro)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function writeSpec(name: string, doc: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-diff-deprecated-'));
    dirs.push(dir);
    const file = path.join(dir, name);
    await fs.writeFile(file, JSON.stringify(doc));
    return file;
  }

  it('reports one change per node that gained deprecated: true, none breaking', async () => {
    const before = await parseSpec(path.join(fixtures, 'deprecated-before.json'));
    const after = await parseSpec(path.join(fixtures, 'deprecated-after.json'));
    const diff = diffSpecs(before, after);

    expect(diff.changes).toEqual([
      {
        kind: 'model-modified',
        name: 'Pet',
        fieldChanges: [
          {
            kind: 'field-deprecated-changed',
            fieldName: 'status',
            classification: 'additive',
            details: 'live → deprecated',
          },
        ],
        deprecatedChanged: true,
        classification: 'additive',
      },
      {
        kind: 'enum-modified',
        name: 'PetStatus',
        valueChanges: [],
        deprecatedChanged: true,
        classification: 'additive',
      },
      {
        kind: 'operation-modified',
        serviceName: 'Pets',
        operationName: 'getPet',
        paramChanges: [],
        responseChanged: false,
        requestBodyChanged: false,
        requestBodyRequiredChanged: false,
        httpMethodChanged: false,
        pathChanged: false,
        paginatedChanged: false,
        injectIdempotencyKeyChanged: false,
        errorsChanged: false,
        deprecatedChanged: true,
        classification: 'additive',
      },
    ]);
    expect(diff.behaviorChanges.map((b) => (b.kind === 'deprecated-changed' ? b.node : b.kind))).toEqual([
      'model',
      'field',
      'enum',
      'operation',
    ]);
    expect(diff.behaviorChanges.every((b) => b.classification === 'additive')).toBe(true);
    expect(diff.summary.breaking).toBe(0);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 3, breaking: 0, additive: 3, behaviorChanges: 4 });
  });

  it('reports the same nodes going the other way when the documents are swapped', async () => {
    const before = await parseSpec(path.join(fixtures, 'deprecated-before.json'));
    const after = await parseSpec(path.join(fixtures, 'deprecated-after.json'));
    const diff = diffSpecs(after, before);

    expect(diff.changes.map((c) => c.kind)).toEqual(['model-modified', 'enum-modified', 'operation-modified']);
    expect(diff.changes.every((c) => c.classification === 'additive')).toBe(true);
    expect(diff.behaviorChanges).toHaveLength(4);
    for (const b of diff.behaviorChanges) {
      expect(b).toMatchObject({ kind: 'deprecated-changed', oldDeprecated: true, newDeprecated: false });
    }
    expect(diff.summary.breaking).toBe(0);
  });

  it('reports nothing when the same document is parsed twice', async () => {
    const a = await parseSpec(path.join(fixtures, 'deprecated-before.json'));
    const b = await parseSpec(path.join(fixtures, 'deprecated-before.json'));
    expect(diffSpecs(a, b).changes).toEqual([]);
    expect(diffSpecs(a, b).behaviorChanges).toEqual([]);
  });

  it('reports a parameter the document deprecates, named with its location', async () => {
    const doc = JSON.parse(await fs.readFile(path.join(fixtures, 'deprecated-before.json'), 'utf8'));
    doc.paths['/pets/{id}'].get.parameters[0].deprecated = true;
    const before = await parseSpec(path.join(fixtures, 'deprecated-before.json'));
    const after = await parseSpec(await writeSpec('param.json', doc));
    const diff = diffSpecs(before, after);

    expect(diff.changes).toMatchObject([
      {
        kind: 'operation-modified',
        operationName: 'getPet',
        deprecatedChanged: false,
        paramChanges: [
          {
            kind: 'param-deprecated-changed',
            paramName: 'id',
            paramLocation: 'path',
            classification: 'additive',
            details: 'live → deprecated',
          },
        ],
        classification: 'additive',
      },
    ]);
    expect(diff.behaviorChanges).toEqual([
      {
        kind: 'deprecated-changed',
        node: 'parameter',
        serviceName: 'Pets',
        operationName: 'getPet',
        paramName: 'id',
        paramLocation: 'path',
        oldDeprecated: false,
        newDeprecated: true,
        classification: 'additive',
      },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 1 });
  });
});
