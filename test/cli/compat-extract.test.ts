import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { registerExtractor } from '../../src/compat/extractor-registry.js';
import type { ApiSurface, Extractor } from '../../src/compat/types.js';
import { apiSurfaceToSnapshot, type CompatSnapshot } from '../../src/compat/ir.js';
import type { OperationHint } from '../../src/ir/operation-hints.js';
import { nodeHints } from '../../src/compat/language-hints.js';
import { compatExtractCommand } from '../../src/cli/compat-extract.js';
import { COMPAT_SCHEMA_VERSION } from '../../src/compat/schema.js';

describe('compatExtractCommand', () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  const mockSnapshot: CompatSnapshot = {
    schemaVersion: COMPAT_SCHEMA_VERSION,
    source: { extractedAt: '2026-01-01T00:00:00.000Z' },
    policies: {
      callerUsesParamNames: false,
      constructorOrderMatters: false,
      constructorParameterNamesArePublicApi: false,
      methodParameterNamesArePublicApi: false,
      overloadsArePublicApi: true,
      arityIsPublicApi: false,
    },
    symbols: [
      {
        id: 'class:TestClient',
        kind: 'service_accessor',
        fqName: 'TestClient',
        displayName: 'TestClient',
        visibility: 'public',
        stability: 'stable',
        sourceKind: 'generated_service_wrapper',
      },
    ],
  };

  const mockExtractor: Extractor = {
    language: 'test-compat-extract-lang',
    hints: nodeHints,
    extract: vi.fn().mockResolvedValue({
      language: 'test-compat-extract-lang',
      extractedFrom: '/test',
      extractedAt: '2026-01-01T00:00:00.000Z',
      classes: {
        TestClient: {
          name: 'TestClient',
          methods: {},
          properties: {},
          constructorParams: [],
        },
      },
      interfaces: {},
      typeAliases: {},
      enums: {},
      exports: {},
    }),
    extractSnapshot: vi.fn().mockResolvedValue(mockSnapshot),
  };

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-compat-extract-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    registerExtractor(mockExtractor);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a valid compat snapshot JSON to output path', async () => {
    await compatExtractCommand({
      sdkPath: '/some/sdk',
      lang: 'test-compat-extract-lang',
      output: tmpDir,
    });

    const written = JSON.parse(readFileSync(resolve(tmpDir, '.oagen-compat-snapshot.json'), 'utf-8'));
    expect(written.schemaVersion).toBe(COMPAT_SCHEMA_VERSION);
    expect(Array.isArray(written.symbols)).toBe(true);
    expect(written.symbols).toHaveLength(1);
    expect(written.symbols[0].id).toBe('class:TestClient');
  });

  it('logs extraction progress and symbol count', async () => {
    await compatExtractCommand({
      sdkPath: '/some/sdk',
      lang: 'test-compat-extract-lang',
      output: tmpDir,
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Extracting test-compat-extract-lang'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('1 symbols'));
  });
});

describe('#567', () => {
  // `compat-extract` has to parse `--spec` as `generate` parses it, or the
  // snapshot's spec identity is matched against operation names and models
  // the SDK does not have.
  const lang = 'test-compat-extract-567';
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  const pet = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
  const ok = (schema: unknown) => ({ '200': { description: 'ok', content: { 'application/json': { schema } } } });
  const doc = (paths: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'pets', version: '1' },
    tags: [{ name: 'Pets' }],
    paths,
    components: { schemas: { Pet: pet } },
  });
  const iface = (name: string, fields: Record<string, string>) => ({
    name,
    fields: Object.fromEntries(Object.entries(fields).map(([n, type]) => [n, { name: n, type, optional: false }])),
    extends: [],
  });
  const register = (parts: Partial<ApiSurface>) => {
    const surface: ApiSurface = {
      language: lang,
      extractedFrom: '/sdk',
      extractedAt: '2026-01-01T00:00:00.000Z',
      classes: {},
      interfaces: {},
      typeAliases: {},
      enums: {},
      exports: {},
      ...parts,
    };
    registerExtractor({
      language: lang,
      hints: nodeHints,
      extract: async () => surface,
      extractSnapshot: async () => apiSurfaceToSnapshot(surface),
    });
  };
  const symbolsAfter = async (spec: string, options: Partial<Parameters<typeof compatExtractCommand>[0]>) => {
    await compatExtractCommand({ sdkPath: '/sdk', lang, output: tmpDir, spec, ...options });
    return (JSON.parse(readFileSync(resolve(tmpDir, '.oagen-compat-snapshot.json'), 'utf-8')) as CompatSnapshot)
      .symbols;
  };

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-compat-extract-567-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses with operationIdTransform, so the methods it names get their operation identity', async () => {
    // The SDK has `Pets.get` and `Pets.list`, as `generate` names them under
    // a transform that strips `PetsController_`; parsed without it, the
    // operations are `petsControllerGet` and `petsControllerList` and the
    // methods match nothing.
    register({
      classes: {
        Pets: {
          name: 'Pets',
          methods: {
            get: [{ name: 'get', params: [], returnType: 'Pet', async: true }],
            list: [{ name: 'list', params: [], returnType: 'Pet[]', async: true }],
          },
          properties: {},
          constructorParams: [],
        },
      },
    });
    const spec = resolve(tmpDir, 'pets.json');
    writeFileSync(
      spec,
      JSON.stringify(
        doc({
          '/pets': {
            get: {
              operationId: 'PetsController_list',
              tags: ['Pets'],
              responses: ok({ type: 'array', items: { $ref: '#/components/schemas/Pet' } }),
            },
          },
          '/pets/{id}': {
            get: {
              operationId: 'PetsController_get',
              tags: ['Pets'],
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: ok({ $ref: '#/components/schemas/Pet' }),
            },
          },
        }),
      ),
    );
    const callables = async (operationIdTransform?: (id: string) => string) =>
      (await symbolsAfter(spec, { operationIdTransform }))
        .filter((s) => s.kind === 'callable')
        .map(({ fqName, operationId, route }) => ({ fqName, operationId, route }));

    expect(await callables()).toEqual([{ fqName: 'Pets.get' }, { fqName: 'Pets.list' }]);
    expect(
      await callables((id) => (id.startsWith('PetsController_') ? id.slice('PetsController_'.length) : id)),
    ).toEqual([
      { fqName: 'Pets.get', operationId: 'get', route: { method: 'get', path: '/pets/{id}' } },
      { fqName: 'Pets.list', operationId: 'list', route: { method: 'get', path: '/pets' } },
    ]);
  });

  it('parses with operationHints, so the models a pagination hint makes generation write get their schema name', async () => {
    // GET /pets with an `after` query parameter and a list envelope is
    // detected as cursor pagination, so the envelope is the iterator's and
    // `Pet` the only model; under `pagination: { strategy: 'none' }` it is a
    // plain operation and generation writes `ListPetsResponse` and
    // `ListPetsResponseListMetadata` beside `Pet`.
    register({
      interfaces: {
        ListPetsResponse: iface('ListPetsResponse', { data: 'Pet[]', list_metadata: 'ListPetsResponseListMetadata' }),
        ListPetsResponseListMetadata: iface('ListPetsResponseListMetadata', { after: 'string' }),
        Pet: iface('Pet', { name: 'string' }),
      },
    });
    const spec = resolve(tmpDir, 'list.json');
    writeFileSync(
      spec,
      JSON.stringify(
        doc({
          '/pets': {
            get: {
              operationId: 'listPets',
              parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
              responses: ok({
                type: 'object',
                required: ['data', 'list_metadata'],
                properties: {
                  data: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
                  list_metadata: { type: 'object', properties: { after: { type: 'string' } } },
                },
              }),
            },
          },
        }),
      ),
    );
    const schemaNames = async (operationHints?: Record<string, OperationHint>) =>
      (await symbolsAfter(spec, { operationHints })).map((s) => s.schemaName).filter(Boolean);

    expect(await schemaNames()).toEqual(['Pet', 'Pet.name']);
    expect(await schemaNames({ 'GET /pets': { pagination: { strategy: 'none' } } })).toEqual([
      'ListPetsResponse',
      'ListPetsResponse.data',
      'ListPetsResponse.list_metadata',
      'ListPetsResponseListMetadata',
      'ListPetsResponseListMetadata.after',
      'Pet',
      'Pet.name',
    ]);
  });
});
