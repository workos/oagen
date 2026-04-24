import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');
const MINIMAL_SPEC = resolve(FIXTURES, 'minimal.yml');

const EMPTY_SURFACE = {
  language: 'test-lang',
  extractedFrom: '/test',
  extractedAt: '2024-01-01T00:00:00Z',
  classes: {},
  interfaces: {},
  typeAliases: {},
  enums: {},
  exports: {},
};

// Mock the orchestrator to avoid needing a real emitter
vi.mock('../../src/engine/orchestrator.js', () => ({
  generate: vi.fn().mockResolvedValue([
    { path: 'test-lang/models/user.ts', content: '// generated' },
    { path: 'test-lang/client.ts', content: '// generated' },
  ]),
}));

// Mock the registry
vi.mock('../../src/engine/registry.js', () => ({
  getEmitter: vi.fn().mockReturnValue({ language: 'test-lang' }),
}));

import { generateCommand } from '../../src/cli/generate.js';

describe('generateCommand', () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-gen-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs dry-run and prints file paths', async () => {
    await generateCommand({
      spec: MINIMAL_SPEC,
      lang: 'test-lang',
      output: tmpDir,
      dryRun: true,
    });

    expect(consoleSpy).toHaveBeenCalledWith('test-lang/models/user.ts');
    expect(consoleSpy).toHaveBeenCalledWith('test-lang/client.ts');
  });

  it('runs full generation and prints summary', async () => {
    await generateCommand({
      spec: MINIMAL_SPEC,
      lang: 'test-lang',
      output: tmpDir,
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Generated 2 files'));
  });

  it('passes namespace through to generation', async () => {
    const { generate } = await import('../../src/engine/orchestrator.js');
    await generateCommand({
      spec: MINIMAL_SPEC,
      lang: 'test-lang',
      output: tmpDir,
      namespace: 'my-sdk',
      dryRun: true,
    });

    expect(generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ namespace: 'my-sdk' }),
    );
  });

  it('loads API surface and builds overlay when --api-surface is provided', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(EMPTY_SURFACE));

    await generateCommand({
      spec: MINIMAL_SPEC,
      lang: 'test-lang',
      output: tmpDir,
      apiSurface: surfacePath,
      dryRun: true,
    });

    const { generate } = await import('../../src/engine/orchestrator.js');
    expect(generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        apiSurface: expect.objectContaining({ classes: {} }),
      }),
    );
  });

  it('throws when API surface file does not exist', async () => {
    await expect(
      generateCommand({
        spec: MINIMAL_SPEC,
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: '/nonexistent/surface.json',
      }),
    ).rejects.toThrow('API surface file not found');
  });

  it('throws when API surface is invalid JSON', async () => {
    const surfacePath = resolve(tmpDir, 'bad-surface.json');
    writeFileSync(surfacePath, 'not json');

    await expect(
      generateCommand({
        spec: MINIMAL_SPEC,
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: surfacePath,
      }),
    ).rejects.toThrow('Failed to parse API surface JSON');
  });

  it('skips overlay when compatCheck is false', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(EMPTY_SURFACE));

    await generateCommand({
      spec: MINIMAL_SPEC,
      lang: 'test-lang',
      output: tmpDir,
      apiSurface: surfacePath,
      compatCheck: false,
      dryRun: true,
    });

    const { generate } = await import('../../src/engine/orchestrator.js');
    expect(generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        apiSurface: undefined,
        overlayLookup: undefined,
      }),
    );
  });
});
