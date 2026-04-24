import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import { registerExtractor } from '../../src/compat/extractor-registry.js';
import type { Extractor } from '../../src/compat/types.js';
import type { CompatSnapshot } from '../../src/compat/ir.js';
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
