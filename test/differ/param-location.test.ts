/**
 * Parameters are matched by location and name (#261, review round 1).
 *
 * OpenAPI allows a path `id` beside a query `id` on one operation. `diffParams`
 * used to key both sides by name alone, so each `Map` kept whichever
 * same-named parameter came last (the query one), and a change to the other
 * was paired with the wrong parameter or dropped — for every parameter flag,
 * not only `deprecated`. Every `paramChanges` entry now carries
 * `paramLocation`, since the name alone no longer says which one it is about.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffOperations } from '../../src/differ/operations.js';
import { parseSpec } from '../../src/parser/parse.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Operation, Parameter } from '../../src/ir/types.js';

const fixtures = path.resolve(import.meta.dirname, '../fixtures');

const pathId: Parameter = { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true };
const queryId: Parameter = { name: 'id', type: { kind: 'primitive', type: 'string' }, required: false };

/** `GET /pets/{id}` with a query `id` beside the path `id`. */
const getPet: Operation = {
  name: 'getPet',
  httpMethod: 'get',
  path: '/pets/{id}',
  pathParams: [pathId],
  queryParams: [queryId],
  headerParams: [],
  response: { kind: 'model', name: 'Pet' },
  errors: [],
  injectIdempotencyKey: false,
};

const specOf = (op: Operation): ApiSpec => ({
  name: 'Pets',
  version: '1',
  baseUrl: 'https://api.example.com',
  models: [],
  enums: [],
  services: [{ name: 'Pets', operations: [op] }],
  sdk: defaultSdkBehavior(),
});

const paramChangesOf = (changes: ReturnType<typeof diffOperations>) =>
  changes[0]?.kind === 'operation-modified' ? changes[0].paramChanges : [];

describe('diffOperations – same-name parameters in different locations', () => {
  it('reports nothing when both are unchanged', () => {
    expect(diffOperations('Pets', [getPet], [getPet])).toHaveLength(0);
  });

  describe('deprecated', () => {
    it('reports only the path parameter becoming deprecated, at its location', () => {
      const modified: Operation = { ...getPet, pathParams: [{ ...pathId, deprecated: true }] };
      expect(paramChangesOf(diffOperations('Pets', [getPet], [modified]))).toEqual([
        {
          kind: 'param-deprecated-changed',
          paramName: 'id',
          classification: 'additive',
          paramLocation: 'path',
          oldDeprecated: false,
          newDeprecated: true,
          details: 'live → deprecated',
        },
      ]);
      expect(diffSpecs(specOf(getPet), specOf(modified)).behaviorChanges).toEqual([
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
    });

    it('reports only the query parameter becoming deprecated, with the real old → new values', () => {
      const modified: Operation = { ...getPet, queryParams: [{ ...queryId, deprecated: true }] };
      expect(paramChangesOf(diffOperations('Pets', [getPet], [modified]))).toEqual([
        {
          kind: 'param-deprecated-changed',
          paramName: 'id',
          classification: 'additive',
          paramLocation: 'query',
          oldDeprecated: false,
          newDeprecated: true,
          details: 'live → deprecated',
        },
      ]);
      // Used to read the unchanged path `id` and report `false → false`.
      expect(diffSpecs(specOf(getPet), specOf(modified)).behaviorChanges).toMatchObject([
        { node: 'parameter', paramName: 'id', paramLocation: 'query', oldDeprecated: false, newDeprecated: true },
      ]);
    });

    it('reports both when both flip, each at its own location', () => {
      const modified: Operation = {
        ...getPet,
        pathParams: [{ ...pathId, deprecated: true }],
        queryParams: [{ ...queryId, deprecated: true }],
      };
      expect(paramChangesOf(diffOperations('Pets', [getPet], [modified]))).toMatchObject([
        { kind: 'param-deprecated-changed', paramName: 'id', paramLocation: 'path' },
        { kind: 'param-deprecated-changed', paramName: 'id', paramLocation: 'query' },
      ]);
    });

    it('reports the path parameter no longer being deprecated while the query one stays deprecated', () => {
      const both: Operation = {
        ...getPet,
        pathParams: [{ ...pathId, deprecated: true }],
        queryParams: [{ ...queryId, deprecated: true }],
      };
      const pathLive: Operation = { ...both, pathParams: [pathId] };
      expect(paramChangesOf(diffOperations('Pets', [both], [pathLive]))).toEqual([
        {
          kind: 'param-deprecated-changed',
          paramName: 'id',
          classification: 'additive',
          paramLocation: 'path',
          oldDeprecated: true,
          newDeprecated: false,
          details: 'deprecated → live',
        },
      ]);
    });
  });

  describe('pre-existing flags (same collision)', () => {
    it('reports a query parameter added beside an existing path parameter of the same name', () => {
      const pathOnly: Operation = { ...getPet, queryParams: [] };
      // Used to find `id` on both sides and report nothing.
      expect(paramChangesOf(diffOperations('Pets', [pathOnly], [getPet]))).toEqual([
        { kind: 'param-added', paramName: 'id', classification: 'additive', paramLocation: 'query' },
      ]);
    });

    it('reports the query parameter removed while the path parameter stays', () => {
      const pathOnly: Operation = { ...getPet, queryParams: [] };
      // Used to pair the old query `id` with the new path `id` and report nothing.
      expect(paramChangesOf(diffOperations('Pets', [getPet], [pathOnly]))).toEqual([
        { kind: 'param-removed', paramName: 'id', classification: 'breaking', paramLocation: 'query' },
      ]);
    });

    it('reports the path parameter changing type while the query parameter is unchanged', () => {
      const retyped: Operation = {
        ...getPet,
        pathParams: [{ ...pathId, type: { kind: 'primitive', type: 'integer' } }],
      };
      // Used to compare the two query entries and report nothing.
      expect(paramChangesOf(diffOperations('Pets', [getPet], [retyped]))).toEqual([
        { kind: 'param-type-changed', paramName: 'id', classification: 'breaking', paramLocation: 'path' },
      ]);
    });

    it('reports the query parameter becoming required while the path parameter is unchanged', () => {
      const required: Operation = { ...getPet, queryParams: [{ ...queryId, required: true }] };
      const changes = diffOperations('Pets', [getPet], [required]);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: 'operation-modified', classification: 'breaking' });
      expect(paramChangesOf(changes)).toEqual([
        { kind: 'param-required-changed', paramName: 'id', classification: 'breaking', paramLocation: 'query' },
      ]);
    });

    it('reports a default appearing on the query parameter against the query parameter', () => {
      const defaulted: Operation = { ...getPet, queryParams: [{ ...queryId, default: 'latest' }] };
      expect(paramChangesOf(diffOperations('Pets', [getPet], [defaulted]))).toEqual([
        {
          kind: 'param-default-changed',
          paramName: 'id',
          classification: 'breaking',
          paramLocation: 'query',
          oldDefault: null,
          newDefault: 'latest',
          details: 'default <unset> → latest',
        },
      ]);
      expect(diffSpecs(specOf(getPet), specOf(defaulted)).behaviorChanges).toMatchObject([
        {
          kind: 'param-default-changed',
          paramName: 'id',
          paramLocation: 'query',
          oldDefault: null,
          newDefault: 'latest',
        },
      ]);
    });

    it('reports a format change on the path parameter against the path parameter', () => {
      const formatted: Operation = {
        ...getPet,
        pathParams: [{ ...pathId, type: { kind: 'primitive', type: 'string', format: 'uuid' } }],
      };
      expect(paramChangesOf(diffOperations('Pets', [getPet], [formatted]))).toEqual([
        {
          kind: 'param-format-changed',
          paramName: 'id',
          classification: 'additive',
          paramLocation: 'path',
          details: 'format <unset> → uuid',
        },
      ]);
    });
  });

  it('carries paramLocation on every entry, including header parameters', () => {
    const withHeader: Operation = {
      ...getPet,
      headerParams: [{ name: 'X-Trace', type: { kind: 'primitive', type: 'string' }, required: false }],
    };
    const headerRequired: Operation = {
      ...withHeader,
      headerParams: [{ ...withHeader.headerParams[0], required: true }],
    };
    expect(paramChangesOf(diffOperations('Pets', [getPet], [withHeader]))).toEqual([
      { kind: 'param-added', paramName: 'X-Trace', classification: 'additive', paramLocation: 'header' },
    ]);
    expect(paramChangesOf(diffOperations('Pets', [withHeader], [headerRequired]))).toEqual([
      { kind: 'param-required-changed', paramName: 'X-Trace', classification: 'breaking', paramLocation: 'header' },
    ]);
    expect(paramChangesOf(diffOperations('Pets', [withHeader], [getPet]))).toEqual([
      { kind: 'param-removed', paramName: 'X-Trace', classification: 'breaking', paramLocation: 'header' },
    ]);
  });
});

describe('diffSpecs – end to end (issue #262 repro)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function writeSpec(name: string, doc: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-diff-param-location-'));
    dirs.push(dir);
    const file = path.join(dir, name);
    await fs.writeFile(file, JSON.stringify(doc));
    return file;
  }

  it('reports the path id changing type beside an unchanged query id, breaking, and nothing for the query id', async () => {
    const before = await parseSpec(path.join(fixtures, 'same-name-param-before.json'));
    const after = await parseSpec(path.join(fixtures, 'same-name-param-after.json'));
    const diff = diffSpecs(before, after);

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      kind: 'operation-modified',
      operationName: 'getPet',
      classification: 'breaking',
    });
    if (diff.changes[0].kind === 'operation-modified') {
      expect(diff.changes[0].paramChanges).toEqual([
        { kind: 'param-type-changed', paramName: 'id', classification: 'breaking', paramLocation: 'path' },
      ]);
    }
    expect(diff.behaviorChanges).toEqual([]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 1, additive: 0, behaviorChanges: 0 });
  });

  it('reports the same change as when the path id is the only id', async () => {
    const strip = (doc: { paths: Record<string, { get: { parameters: { in: string }[] } }> }) => {
      doc.paths['/pets/{id}'].get.parameters = doc.paths['/pets/{id}'].get.parameters.filter((p) => p.in === 'path');
      return doc;
    };
    const beforeDoc = strip(JSON.parse(await fs.readFile(path.join(fixtures, 'same-name-param-before.json'), 'utf8')));
    const afterDoc = strip(JSON.parse(await fs.readFile(path.join(fixtures, 'same-name-param-after.json'), 'utf8')));
    const alone = diffSpecs(
      await parseSpec(await writeSpec('before-alone.json', beforeDoc)),
      await parseSpec(await writeSpec('after-alone.json', afterDoc)),
    );
    const beside = diffSpecs(
      await parseSpec(path.join(fixtures, 'same-name-param-before.json')),
      await parseSpec(path.join(fixtures, 'same-name-param-after.json')),
    );
    expect(beside.changes).toEqual(alone.changes);
    expect(beside.summary).toEqual(alone.summary);
  });

  it('reports only the path id becoming deprecated beside an unchanged query id (the #261 mirror case)', async () => {
    const doc = JSON.parse(await fs.readFile(path.join(fixtures, 'same-name-param-before.json'), 'utf8'));
    doc.paths['/pets/{id}'].get.parameters[0].deprecated = true;
    const before = await parseSpec(path.join(fixtures, 'same-name-param-before.json'));
    const after = await parseSpec(await writeSpec('path-deprecated.json', doc));
    const diff = diffSpecs(before, after);

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      kind: 'operation-modified',
      operationName: 'getPet',
      deprecatedChanged: false,
      classification: 'additive',
    });
    if (diff.changes[0].kind === 'operation-modified') {
      expect(diff.changes[0].paramChanges).toEqual([
        {
          kind: 'param-deprecated-changed',
          paramName: 'id',
          classification: 'additive',
          paramLocation: 'path',
          oldDeprecated: false,
          newDeprecated: true,
          details: 'live → deprecated',
        },
      ]);
    }
    expect(diff.behaviorChanges).toMatchObject([
      { kind: 'deprecated-changed', node: 'parameter', paramName: 'id', paramLocation: 'path', newDeprecated: true },
    ]);
    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 1 });
  });

  it('reports nothing when the same document is parsed twice', async () => {
    const a = await parseSpec(path.join(fixtures, 'same-name-param-before.json'));
    const b = await parseSpec(path.join(fixtures, 'same-name-param-before.json'));
    expect(diffSpecs(a, b).changes).toEqual([]);
  });
});
