import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');
const V1 = resolve(FIXTURES, 'v1.yml');
const V2_ADDITIVE = resolve(FIXTURES, 'v2-additive.yml');

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

const stubEmitter = {
  language: 'test-lang',
  generateModels: () => [],
  generateEnums: () => [],
  generateResources: () => [],
  generateClient: () => [],
  generateErrors: () => [],
  generateConfig: () => [],
  generateTypeSignatures: () => [],
  generateTests: () => [],
  fileHeader: () => '// generated',
};

// Mock the registry for incremental gen — use a plain function (not vi.fn)
// so vi.restoreAllMocks() does not clear its return value.
vi.mock('../../src/engine/registry.js', () => ({
  getEmitter: () => stubEmitter,
}));

import { diffCommand } from '../../src/cli/diff.js';

describe('diffCommand', () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-diff-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('outputs JSON report in --report mode', async () => {
    // process.exit is called after console.log in report mode — catch it
    await expect(
      diffCommand({
        old: V1,
        new: V2_ADDITIVE,
        report: true,
      }),
    ).rejects.toThrow('process.exit called');

    // Find the call that contains valid JSON (the diff report)
    const jsonCall = consoleSpy.mock.calls.find((call) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const diff = JSON.parse(jsonCall![0] as string);
    expect(diff).toHaveProperty('changes');
    expect(diff).toHaveProperty('summary');
  });

  it('exits 2 for breaking changes in report mode', async () => {
    // Lines 28-29: breaking changes → exit code 2
    const V2_BREAKING = resolve(FIXTURES, 'v2-breaking.yml');
    await expect(
      diffCommand({
        old: V1,
        new: V2_BREAKING,
        report: true,
      }),
    ).rejects.toThrow('process.exit called');

    const jsonCall = consoleSpy.mock.calls.find((call) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    const diff = JSON.parse(jsonCall![0] as string);
    expect(diff.summary.breaking).toBeGreaterThan(0);
  });

  it('exits 0 for no changes in report mode', async () => {
    // Line 34: no changes → exit code 0
    await expect(
      diffCommand({
        old: V1,
        new: V1,
        report: true,
      }),
    ).rejects.toThrow('process.exit called');
  });

  it('prints "No changes detected" when specs are identical', async () => {
    // Line 85: no changes → "No changes detected"
    await diffCommand({
      old: V1,
      new: V1,
      lang: 'test-lang',
      output: tmpDir,
    });

    expect(consoleSpy).toHaveBeenCalledWith('No changes detected');
  });

  it('exits 1 when --lang is missing for incremental gen', async () => {
    await expect(
      diffCommand({
        old: V1,
        new: V2_ADDITIVE,
        output: tmpDir,
      }),
    ).rejects.toThrow('process.exit called');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--lang'));
  });

  it('exits 1 when --output is missing for incremental gen', async () => {
    await expect(
      diffCommand({
        old: V1,
        new: V2_ADDITIVE,
        lang: 'test-lang',
      }),
    ).rejects.toThrow('process.exit called');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--output'));
  });

  it('runs incremental generation with --lang and --output', async () => {
    await diffCommand({
      old: V1,
      new: V2_ADDITIVE,
      lang: 'test-lang',
      output: tmpDir,
    });

    // Should print either "No changes" or "Regenerated N files"
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('loads API surface when --api-surface is provided', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(EMPTY_SURFACE));

    await diffCommand({
      old: V1,
      new: V2_ADDITIVE,
      lang: 'test-lang',
      output: tmpDir,
      apiSurface: surfacePath,
    });

    expect(consoleSpy).toHaveBeenCalled();
  });

  it('throws when API surface file does not exist', async () => {
    await expect(
      diffCommand({
        old: V1,
        new: V2_ADDITIVE,
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: '/nonexistent/surface.json',
      }),
    ).rejects.toThrow('API surface file not found');
  });

  it('throws when API surface is invalid JSON', async () => {
    const surfacePath = resolve(tmpDir, 'bad.json');
    writeFileSync(surfacePath, 'not valid json');

    await expect(
      diffCommand({
        old: V1,
        new: V2_ADDITIVE,
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: surfacePath,
      }),
    ).rejects.toThrow('Failed to parse API surface JSON');
  });

  it('throws when explicit --manifest file does not exist', async () => {
    const surfacePath = resolve(tmpDir, 'surface.json');
    writeFileSync(surfacePath, JSON.stringify(EMPTY_SURFACE));

    await expect(
      diffCommand({
        old: V1,
        new: V2_ADDITIVE,
        lang: 'test-lang',
        output: tmpDir,
        apiSurface: surfacePath,
        manifest: '/nonexistent/manifest.json',
      }),
    ).rejects.toThrow('Failed to read manifest');
  });
});
