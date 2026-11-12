import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { resolveOperations } from '../../src/ir/operation-hints.js';
import type { OperationResolution } from '../../src/ir/operation-hints.js';
import {
  specDerivedNames,
  specDerivedMethodPaths,
  filterSurface,
  normalizeMemberName,
  memberKeysByClass,
} from '../../src/compat/spec-filter.js';
import { detectStaleSymbols } from '../../src/compat/staleness.js';
import { nodeHints } from '../../src/compat/language-hints.js';
import type { ApiSurface, ApiClass, OverlayLookup } from '../../src/compat/types.js';
import type { ApiSpec } from '../../src/ir/types.js';

describe('#600', () => {
  // `oagen verify --scope spec-only` keeps the baseline symbols
  // `specDerivedNames` derives from the spec and filters a service class's
  // methods by `specDerivedMethodPaths`. Both read the IR as parsed —
  // `Service.name` and `Operation.name` — not the operations as `generate`
  // resolves them (`mountOn` and `methodName`, under the config's
  // `mountRules`, `operationHints` and `operationNaming`), so a service
  // remounted by `mountRules` was scoped out of the compat check altogether,
  // the method paths matched the SDK's method names only under
  // `operationNaming: 'operationId'`, and the staleness check never found a
  // remounted service stale. Now the scope reads the resolution `generate`
  // emits from: service names from `mountOn`, method paths from `mountOn` and
  // `methodName`, matched in any language's casing.
  let dir: string;

  const ok = (schema: unknown) => ({ '200': { description: 'ok', content: { 'application/json': { schema } } } });
  const pet = { $ref: '#/components/schemas/Pet' };
  const listPets = {
    get: { operationId: 'list', tags: ['Pets'], responses: ok({ type: 'array', items: pet }) },
  };
  const getPet = {
    get: {
      operationId: 'get',
      tags: ['Pets'],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: ok(pet),
    },
  };
  const createPet = {
    post: {
      operationId: 'create',
      tags: ['Pets'],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } },
      },
      responses: ok(pet),
    },
  };
  const listDogs = {
    get: { operationId: 'listDogs', tags: ['Dogs'], responses: ok({ type: 'array', items: pet }) },
  };
  // The issue's `pets.json`: `GET /pets` (`operationId: list`) and
  // `GET /pets/{id}` (`operationId: get`), both tagged `Pets`, returning
  // `Pet { name?: string }` (an array of it for `list`); on OAS 3.0.3 and
  // 3.1.0, in both path orders.
  const doc = (openapi: string, paths: Record<string, unknown>) => ({
    openapi,
    info: { title: 'pets', version: '1' },
    tags: [{ name: 'Pets' }, { name: 'Dogs' }],
    paths,
    components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } } },
  });
  const versions = ['3.0.3', '3.1.0'];
  const orders = {
    'list first': { '/pets': listPets, '/pets/{id}': getPet },
    'get first': { '/pets/{id}': getPet, '/pets': listPets },
  };
  const parse = async (name: string, document: unknown): Promise<ApiSpec> => {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(document));
    return parseSpec(file);
  };
  const sorted = (set: Iterable<string>) => [...set].sort();
  // What `generate` writes, as the issue prints it (sorted: the resolution
  // follows the document's path order).
  const resolvedAs = (spec: ApiSpec, resolution?: OperationResolution) =>
    sorted(
      resolveOperations(spec, resolution?.operationHints, resolution?.mountRules, resolution?.operationNaming).map(
        ({ mountOn, methodName }) => `${mountOn}.${methodName}`,
      ),
    );

  // The issue's settings.
  const mountRules = { Pets: 'Animals' };
  const operationHints = { 'GET /pets': { name: 'list_all' } };
  const hints = { ...nodeHints, derivedModelNames: () => [] };

  const method = (name: string) => [{ name, params: [], returnType: 'Pet', async: true }];
  const serviceClass = (name: string, methods: string[]): ApiClass => ({
    name,
    methods: Object.fromEntries(methods.map((m) => [m, method(m)])),
    properties: {},
    constructorParams: [],
  });
  const surface = (classes: Record<string, ApiClass>): ApiSurface => ({
    language: 'node',
    extractedFrom: '/sdk',
    extractedAt: '2026-01-01T00:00:00.000Z',
    classes,
    interfaces: {
      Pet: { name: 'Pet', fields: { name: { name: 'name', type: 'string', optional: true } }, extends: [] },
    },
    typeAliases: {},
    enums: {},
    exports: {},
  });
  const scopeOf = (spec: ApiSpec, baseline: ApiSurface, resolution?: OperationResolution) => {
    const scoped = filterSurface(baseline, specDerivedNames(spec, hints, resolution), {
      methodPaths: specDerivedMethodPaths(spec, resolution),
    });
    return Object.fromEntries(
      Object.entries(scoped.classes).map(([name, cls]) => [name, Object.keys(cls.methods).sort()]),
    );
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oagen-600-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe.each(versions)('OAS %s', (openapi) => {
    describe.each(Object.entries(orders))('%s', (_order, paths) => {
      it('reads the names and method paths from the resolution generate emits from', async () => {
        const spec = await parse(`pets-${openapi}-${_order}`, doc(openapi, paths));

        expect(resolvedAs(spec, { operationHints, mountRules })).toEqual(['Animals.get_pet', 'Animals.list_all']);
        expect(resolvedAs(spec, { operationNaming: 'path' })).toEqual(['Pets.get_pet', 'Pets.list_pets']);
        expect(resolvedAs(spec, { operationNaming: 'operationId' })).toEqual(['Pets.get', 'Pets.list']);

        // The scope under the issue's settings: the mount target, and the
        // resolved method names on it — beside the IR's operation names on
        // it, the key the scope read before.
        expect(sorted(specDerivedNames(spec, hints, { operationHints, mountRules }))).toEqual(['Animals', 'Pet']);
        expect(sorted(specDerivedMethodPaths(spec, { operationHints, mountRules }))).toEqual([
          'Animals.get',
          'Animals.get_pet',
          'Animals.list',
          'Animals.list_all',
        ]);

        // With no settings, as `generate` resolves with no config: path naming.
        expect(sorted(specDerivedNames(spec, hints))).toEqual(['Pet', 'Pets']);
        expect(sorted(specDerivedMethodPaths(spec))).toEqual([
          'Pets.get',
          'Pets.get_pet',
          'Pets.list',
          'Pets.list_pets',
        ]);

        // Under `operationNaming: 'operationId'` the resolved names are the
        // operationIds, snake_cased, so the two keys coincide.
        expect(sorted(specDerivedMethodPaths(spec, { operationNaming: 'operationId' }))).toEqual([
          'Pets.get',
          'Pets.list',
        ]);
      });
    });
  });

  it('counts an operation a mountOn hint moves under the target class, as generate places it', async () => {
    const spec = await parse('mount-on', doc('3.1.0', orders['list first']));
    const resolution = { operationHints: { 'GET /pets/{id}': { mountOn: 'Lookups' } } };

    expect(resolvedAs(spec, resolution)).toEqual(['Lookups.get_pet', 'Pets.list_pets']);
    expect(sorted(specDerivedNames(spec, hints, resolution))).toEqual(['Lookups', 'Pet', 'Pets']);
    expect(sorted(specDerivedMethodPaths(spec, resolution))).toEqual([
      'Lookups.get',
      'Lookups.get_pet',
      'Pets.list',
      'Pets.list_pets',
    ]);

    // A hint that moves every operation of a service leaves the source name
    // out: `generate` writes no `Pets` class then.
    const all = {
      operationHints: { 'GET /pets': { mountOn: 'Lookups' }, 'GET /pets/{id}': { mountOn: 'Lookups' } },
    };
    expect(sorted(specDerivedNames(spec, hints, all))).toEqual(['Lookups', 'Pet']);
  });

  it("keys a split hint's wrappers on the mount target beside the operation", async () => {
    const spec = await parse(
      'split',
      doc('3.1.0', { ...orders['list first'], '/pets': { ...listPets, ...createPet } }),
    );
    const resolution = {
      mountRules,
      operationHints: { 'POST /pets': { split: [{ name: 'create_cat', targetVariant: 'Cat' }] } },
    };

    expect(sorted(specDerivedMethodPaths(spec, resolution))).toEqual([
      'Animals.create',
      'Animals.create_cat',
      'Animals.create_pet',
      'Animals.get',
      'Animals.get_pet',
      'Animals.list',
      'Animals.list_pets',
    ]);
  });

  it('matches a method path in any language casing', async () => {
    const spec = await parse('casing', doc('3.1.0', orders['list first']));
    const resolution = { operationHints, mountRules };

    expect(normalizeMemberName('list_all')).toBe('listall');
    expect(normalizeMemberName('listAll')).toBe('listall');
    expect(normalizeMemberName('ListAll')).toBe('listall');
    expect(memberKeysByClass(['Animals.list_all', 'Animals.get_pet', 'Pet'])).toEqual(
      new Map([['Animals', new Set(['listall', 'getpet'])]]),
    );

    // A Node, a Ruby and a .NET SDK's `Animals`, each with a hand-written
    // `feed` beside the two methods the spec derives.
    const sdks = {
      Node: serviceClass('Animals', ['listAll', 'getPet', 'feed']),
      Ruby: serviceClass('Animals', ['list_all', 'get_pet', 'feed']),
      DotNet: serviceClass('Animals', ['ListAll', 'GetPet', 'Feed']),
    };
    for (const [language, cls] of Object.entries(sdks)) {
      const kept = scopeOf(spec, surface({ Animals: cls }), resolution);
      expect(kept, language).toEqual({
        Animals: Object.keys(cls.methods)
          .filter((m) => !/feed/i.test(m))
          .sort(),
      });
      // Read from the IR as parsed, `Animals` was no name the spec derived.
      expect(scopeOf(spec, surface({ Animals: cls })), language).toEqual({});
    }
    // The `Pets` class, which `generate` does not write under the rule, is
    // out of scope; with no settings it is the class `generate` writes.
    const pets = surface({ Pets: serviceClass('Pets', ['list', 'get', 'feed']) });
    expect(scopeOf(spec, pets, resolution)).toEqual({});
    expect(scopeOf(spec, pets)).toEqual({ Pets: ['get', 'list'] });
  });

  describe('staleness', () => {
    const resolution = { operationHints, mountRules };

    it('finds a method of a remounted service stale on the class generate wrote it to', async () => {
      const oldSpec = await parse('stale-old', doc('3.1.0', orders['list first']));
      const newSpec = await parse('stale-new', doc('3.1.0', { '/pets/{id}': getPet }));
      const live = surface({ Animals: serviceClass('Animals', ['listAll', 'getPet', 'feed']) });

      // Read from the IR as parsed, `Animals` was in neither spec's names and
      // the removed `Pets.list` was looked for on a `Pets` class: nothing.
      expect(detectStaleSymbols(live, oldSpec, newSpec, hints)).toEqual([]);
      expect(detectStaleSymbols(live, oldSpec, newSpec, hints, resolution)).toEqual([
        {
          category: 'staleness',
          severity: 'warning',
          symbolPath: 'Animals.listAll',
          baseline: 'listAll',
          candidate: '(removed from spec)',
          message: 'Method "Animals.listAll" is no longer defined in the OpenAPI spec',
        },
      ]);
    });

    it('finds the methods of a service dropped from a mount target another service keeps', async () => {
      // `Pets` and `Dogs` both mount on `Animals`; the new spec drops the
      // `Pets` tag. The differ reports that as `service-removed` with no
      // `operation-removed` per operation, so the two methods were never
      // found; `Animals` itself survives through `Dogs`.
      const merged = { mountRules: { Pets: 'Animals', Dogs: 'Animals' } };
      const oldSpec = await parse('merged-old', doc('3.1.0', { ...orders['list first'], '/dogs': listDogs }));
      const newSpec = await parse('merged-new', doc('3.1.0', { '/dogs': listDogs }));
      const live = surface({ Animals: serviceClass('Animals', ['listPets', 'getPet', 'listDogs']) });

      expect(detectStaleSymbols(live, oldSpec, newSpec, hints, merged).map((v) => v.symbolPath)).toEqual([
        'Animals.listPets',
        'Animals.getPet',
      ]);
    });

    it('reports a class the new spec no longer mounts once, not again per method', async () => {
      const oldSpec = await parse('gone-old', doc('3.1.0', orders['list first']));
      const newSpec = await parse('gone-new', doc('3.1.0', {}));
      const live = surface({ Animals: serviceClass('Animals', ['listAll', 'getPet']) });

      expect(detectStaleSymbols(live, oldSpec, newSpec, hints, resolution).map((v) => v.message)).toEqual([
        'Class "Animals" is no longer defined in the OpenAPI spec',
      ]);
    });
  });

  describe('the compat overlay', () => {
    // `generate --api-surface` writes a baseline method the overlay maps to an
    // operation (`.oagen-manifest.json`: `GET /pets` → `Animals.fetchAll`)
    // under the baseline's name, not the resolved one, so that name has to
    // be a key too, or `filterSurface` drops the method and an SDK that
    // renamed it passes `verify` (Michael's finding on #657).
    const resolution = { mountRules };
    const overlayOf = (routes: Record<string, string>): Pick<OverlayLookup, 'methodByOperation'> => ({
      methodByOperation: new Map(
        Object.entries(routes).map(([httpKey, methodName]) => [
          httpKey,
          { className: 'Animals', methodName, params: [], returnType: 'Pet' },
        ]),
      ),
    });
    const kept = overlayOf({ 'GET /pets': 'fetchAll', 'GET /pets/{id}': 'getPet' });
    // A route the spec does not declare derives nothing.
    const legacy = overlayOf({ 'GET /legacy': 'legacy' });

    it('keys a baseline method the overlay maps to a spec operation, under its own name', async () => {
      const spec = await parse('overlay', doc('3.1.0', orders['list first']));

      expect(sorted(specDerivedMethodPaths(spec, resolution, kept))).toEqual([
        'Animals.fetchAll',
        'Animals.get',
        'Animals.getPet',
        'Animals.get_pet',
        'Animals.list',
        'Animals.list_pets',
      ]);
      expect(sorted(specDerivedMethodPaths(spec, resolution, legacy))).toEqual(
        sorted(specDerivedMethodPaths(spec, resolution)),
      );

      const baseline = surface({ Animals: serviceClass('Animals', ['fetchAll', 'getPet', 'legacy']) });
      const scoped = (overlay?: Pick<OverlayLookup, 'methodByOperation'>) =>
        Object.keys(
          filterSurface(baseline, specDerivedNames(spec, hints, resolution), {
            methodPaths: specDerivedMethodPaths(spec, resolution, overlay),
          }).classes.Animals.methods,
        ).sort();
      expect(scoped()).toEqual(['getPet']);
      expect(scoped(kept)).toEqual(['fetchAll', 'getPet']);
      expect(scoped(legacy)).toEqual(['getPet']);
    });

    it('finds a method the overlay keeps stale once its operation is gone', async () => {
      const oldSpec = await parse('overlay-old', doc('3.1.0', orders['list first']));
      const newSpec = await parse('overlay-new', doc('3.1.0', { '/pets/{id}': getPet }));
      const live = surface({ Animals: serviceClass('Animals', ['fetchAll', 'getPet']) });

      expect(detectStaleSymbols(live, oldSpec, newSpec, hints, resolution)).toEqual([]);
      expect(detectStaleSymbols(live, oldSpec, newSpec, hints, resolution, kept).map((v) => v.symbolPath)).toEqual([
        'Animals.fetchAll',
      ]);
      // Still declared: not stale.
      expect(detectStaleSymbols(live, oldSpec, oldSpec, hints, resolution, kept)).toEqual([]);
    });
  });
});
