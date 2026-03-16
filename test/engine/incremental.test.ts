import { describe, it, expect, vi } from 'vitest';
import { generateIncremental } from '../../src/engine/incremental.js';
import type { Emitter, EmitterContext } from '../../src/engine/types.js';
import type { ApiSpec } from '../../src/ir/types.js';
import type { ApiSurface, OverlayLookup } from '../../src/compat/types.js';

function mockEmitter(ctxCapture?: { ctx?: EmitterContext }): Emitter {
  return {
    language: 'mock',
    generateModels: (models, ctx) => {
      if (ctxCapture) ctxCapture.ctx = ctx;
      return models.map((m) => ({ path: `models/${m.name.toLowerCase()}.rb`, content: `class ${m.name}; end` }));
    },
    generateEnums: (enums) =>
      enums.map((e) => ({ path: `models/${e.name.toLowerCase()}.rb`, content: `class ${e.name}; end` })),
    generateResources: (services) =>
      services.map((s) => ({ path: `resources/${s.name.toLowerCase()}.rb`, content: `class ${s.name}; end` })),
    generateClient: () => [{ path: 'client.rb', content: 'class Client; end' }],
    generateErrors: () => [{ path: 'errors.rb', content: 'class Error; end' }],
    generateConfig: () => [{ path: 'config.rb', content: 'module Config; end' }],
    generateTypeSignatures: (spec) => [
      ...spec.models.map((m) => ({ path: `sig/${m.name.toLowerCase()}.rbs`, content: '' })),
      ...spec.services.map((s) => ({ path: `sig/${s.name.toLowerCase()}.rbs`, content: '' })),
    ],
    generateTests: (spec) => spec.services.map((s) => ({ path: `test/test_${s.name.toLowerCase()}.rb`, content: '' })),
    fileHeader: () => '# generated',
  };
}

const v1: ApiSpec = {
  name: 'Test',
  version: '1.0.0',
  baseUrl: 'https://api.example.com',
  models: [
    {
      name: 'User',
      fields: [
        { name: 'id', type: { kind: 'primitive', type: 'string' }, required: true },
        { name: 'name', type: { kind: 'primitive', type: 'string' }, required: true },
      ],
    },
  ],
  enums: [],
  services: [
    {
      name: 'Users',
      operations: [
        {
          name: 'getUser',
          httpMethod: 'get',
          path: '/users/{id}',
          pathParams: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
          queryParams: [],
          headerParams: [],
          response: { kind: 'model', name: 'User' },
          errors: [],
          paginated: false,
          idempotent: false,
        },
      ],
    },
  ],
};

describe('generateIncremental', () => {
  it('returns empty for identical specs', async () => {
    const result = await generateIncremental(v1, v1, mockEmitter(), {
      namespace: 'Test',
      outputDir: '/tmp/test-inc',
      dryRun: true,
    });
    expect(result.generated).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.diff.changes).toHaveLength(0);
  });

  it('regenerates model files when model changes', async () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      models: [
        {
          ...v1.models[0],
          fields: [
            ...v1.models[0].fields,
            { name: 'email', type: { kind: 'primitive', type: 'string' }, required: false },
          ],
        },
      ],
    };

    const result = await generateIncremental(v1, v2, mockEmitter(), {
      namespace: 'Test',
      outputDir: '/tmp/test-inc',
      dryRun: true,
    });

    const paths = result.generated.map((f) => f.path);
    expect(paths).toContain('models/user.rb');
    expect(paths).toContain('sig/user.rbs');
    // Should also regenerate service that references User
    expect(paths).toContain('resources/users.rb');
  });

  it('adds new model files when model added', async () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      models: [
        ...v1.models,
        {
          name: 'Team',
          fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
      ],
    };

    const result = await generateIncremental(v1, v2, mockEmitter(), {
      namespace: 'Test',
      outputDir: '/tmp/test-inc',
      dryRun: true,
    });

    const paths = result.generated.map((f) => f.path);
    expect(paths).toContain('models/team.rb');
    expect(paths).toContain('sig/team.rbs');
  });

  it('does not delete files without --force', async () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      models: [],
      services: v1.services.map((s) => ({
        ...s,
        operations: s.operations.map((o) => ({
          ...o,
          response: { kind: 'primitive' as const, type: 'string' as const },
        })),
      })),
    };

    const result = await generateIncremental(v1, v2, mockEmitter(), {
      namespace: 'Test',
      outputDir: '/tmp/test-inc',
      dryRun: true,
    });

    expect(result.deleted).toHaveLength(0);
  });

  it('prepends file header to generated files', async () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      models: [
        ...v1.models,
        {
          name: 'Team',
          fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }],
        },
      ],
    };

    const result = await generateIncremental(v1, v2, mockEmitter(), {
      namespace: 'Test',
      outputDir: '/tmp/test-inc',
      dryRun: true,
    });

    for (const f of result.generated) {
      if (f.content.length > 0) {
        expect(f.content).toMatch(/^# generated\n\n/);
      }
    }
  });

  it('includes diff report in result', async () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      models: [...v1.models, { name: 'Team', fields: [] }],
    };

    const result = await generateIncremental(v1, v2, mockEmitter(), {
      namespace: 'Test',
      outputDir: '/tmp/test-inc',
      dryRun: true,
    });

    expect(result.diff.oldVersion).toBe('1.0.0');
    expect(result.diff.newVersion).toBe('2.0.0');
    expect(result.diff.summary.added).toBeGreaterThan(0);
  });

  it('passes compat overlay fields through EmitterContext', async () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      models: [
        ...v1.models,
        { name: 'Team', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      ],
    };

    const fakeApiSurface: ApiSurface = {
      language: 'mock',
      extractedFrom: '/fake',
      extractedAt: '2024-01-01',
      classes: {},
      interfaces: {},
      typeAliases: {},
      enums: {},
      exports: {},
    };

    const fakeOverlay: OverlayLookup = {
      methodByOperation: new Map(),
      httpKeyByMethod: new Map(),
      interfaceByName: new Map(),
      typeAliasByName: new Map(),
      requiredExports: new Map(),
      modelNameByIR: new Map(),
    };

    const ctxCapture: { ctx?: EmitterContext } = {};
    const result = await generateIncremental(v1, v2, mockEmitter(ctxCapture), {
      namespace: 'Test',
      outputDir: '/tmp/test-inc',
      dryRun: true,
      apiSurface: fakeApiSurface,
      overlayLookup: fakeOverlay,
    });

    expect(ctxCapture.ctx).toBeDefined();
    expect(ctxCapture.ctx!.outputDir).toBe('/tmp/test-inc');
    expect(ctxCapture.ctx!.apiSurface).toBe(fakeApiSurface);
    expect(ctxCapture.ctx!.overlayLookup).toBe(fakeOverlay);
  });

  it('defaults skipIfExists to false on generated files', async () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      models: [
        ...v1.models,
        { name: 'Team', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      ],
    };

    const result = await generateIncremental(v1, v2, mockEmitter(), {
      namespace: 'Test',
      outputDir: '/tmp/test-inc',
      dryRun: true,
    });

    for (const f of result.generated) {
      expect(f.skipIfExists).toBe(false);
    }
  });

  it('calls generateManifest when available', async () => {
    const v2: ApiSpec = {
      ...v1,
      version: '2.0.0',
      models: [
        ...v1.models,
        { name: 'Team', fields: [{ name: 'id', type: { kind: 'primitive', type: 'string' }, required: true }] },
      ],
    };

    const emitter = mockEmitter();
    emitter.generateManifest = vi.fn().mockReturnValue([{ path: 'smoke-manifest.json', content: '{}' }]);

    await generateIncremental(v1, v2, emitter, {
      namespace: 'Test',
      outputDir: '/tmp/test-inc',
      dryRun: true,
    });

    expect(emitter.generateManifest).toHaveBeenCalled();
  });
});
