import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { loadOverlayContext } from '../../src/cli/overlay-loader.js';

/**
 * Covers uncovered branches in overlay-loader.ts:
 * - Lines 50-66: object-format manifest conversion
 * - Error paths for missing/invalid files
 */
describe('loadOverlayContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-overlay-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws ConfigError when API surface file is missing', () => {
    expect(() =>
      loadOverlayContext({
        apiSurfacePath: resolve(tmpDir, 'nonexistent.json'),
        outputDir: tmpDir,
        lang: 'node',
      }),
    ).toThrow(/API surface file not found/);
  });

  it('throws ConfigError when API surface JSON is invalid', () => {
    const surfacePath = resolve(tmpDir, 'bad.json');
    writeFileSync(surfacePath, 'not json{{{');

    expect(() =>
      loadOverlayContext({
        apiSurfacePath: surfacePath,
        outputDir: tmpDir,
        lang: 'node',
      }),
    ).toThrow(/Failed to parse API surface JSON/);
  });

  it('loads array-format manifest', () => {
    const surfacePath = resolve(tmpDir, 'api-surface.json');
    writeFileSync(
      surfacePath,
      JSON.stringify({
        language: 'node',
        extractedFrom: '/test',
        extractedAt: '2024-01-01T00:00:00Z',
        classes: {},
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      }),
    );

    const manifestPath = resolve(tmpDir, 'smoke-manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify([
        {
          operationId: 'listUsers',
          sdkResourceProperty: 'users',
          sdkMethodName: 'list',
          httpMethod: 'GET',
          path: '/users',
          pathParams: [],
          bodyFields: [],
          queryFields: [],
        },
      ]),
    );

    const ctx = loadOverlayContext({
      apiSurfacePath: surfacePath,
      outputDir: tmpDir,
      lang: 'node',
    });
    expect(ctx.apiSurface).toBeDefined();
    expect(ctx.overlayLookup).toBeDefined();
  });

  it('loads object-format manifest and converts to array', () => {
    // Covers lines 50-66: object-format manifest conversion
    const surfacePath = resolve(tmpDir, 'api-surface.json');
    writeFileSync(
      surfacePath,
      JSON.stringify({
        language: 'node',
        extractedFrom: '/test',
        extractedAt: '2024-01-01T00:00:00Z',
        classes: {},
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      }),
    );

    const manifestPath = resolve(tmpDir, 'smoke-manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        'GET /users': { sdkMethod: 'list', service: 'users' },
        'POST /users': { sdkMethod: 'create', service: 'users' },
        'GET /users/{id}': { sdkMethod: 'get', service: 'users' },
      }),
    );

    const ctx = loadOverlayContext({
      apiSurfacePath: surfacePath,
      outputDir: tmpDir,
      lang: 'node',
    });
    expect(ctx.apiSurface).toBeDefined();
    expect(ctx.overlayLookup).toBeDefined();
  });

  it('throws when explicit manifest path is invalid', () => {
    const surfacePath = resolve(tmpDir, 'api-surface.json');
    writeFileSync(
      surfacePath,
      JSON.stringify({
        language: 'node',
        extractedFrom: '/test',
        extractedAt: '2024-01-01T00:00:00Z',
        classes: {},
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      }),
    );

    const badManifest = resolve(tmpDir, 'bad-manifest.json');
    writeFileSync(badManifest, 'not json');

    expect(() =>
      loadOverlayContext({
        apiSurfacePath: surfacePath,
        manifestPath: badManifest,
        outputDir: tmpDir,
        lang: 'node',
      }),
    ).toThrow(/Failed to read manifest/);
  });

  it('ignores missing auto-discovered manifest silently', () => {
    const surfacePath = resolve(tmpDir, 'api-surface.json');
    writeFileSync(
      surfacePath,
      JSON.stringify({
        language: 'node',
        extractedFrom: '/test',
        extractedAt: '2024-01-01T00:00:00Z',
        classes: {},
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      }),
    );

    // No manifest file exists — should not throw
    const ctx = loadOverlayContext({
      apiSurfacePath: surfacePath,
      outputDir: tmpDir,
      lang: 'node',
    });
    expect(ctx.apiSurface).toBeDefined();
  });
});
