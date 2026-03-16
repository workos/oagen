import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import { registerExtractor } from '../../src/compat/extractor-registry.js';
import type { Extractor } from '../../src/compat/types.js';
import { extractCommand } from '../../src/cli/extract.js';

describe('extractCommand', () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  const mockExtractor: Extractor = {
    language: 'test-extract-lang',
    extract: vi.fn().mockResolvedValue({
      classes: { MyClass: { methods: {}, properties: {} } },
      interfaces: { MyInterface: { properties: {} } },
      typeAliases: {},
      enums: { MyEnum: { members: ['A', 'B'] } },
    }),
  };

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-extract-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    registerExtractor(mockExtractor);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts API surface and writes to output file', async () => {
    const outputPath = resolve(tmpDir, 'surface.json');

    await extractCommand({
      sdkPath: '/some/sdk',
      lang: 'test-extract-lang',
      output: outputPath,
    });

    const written = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(written.classes).toHaveProperty('MyClass');
    expect(written.interfaces).toHaveProperty('MyInterface');
    expect(written.enums).toHaveProperty('MyEnum');
  });

  it('logs extraction progress and symbol count', async () => {
    const outputPath = resolve(tmpDir, 'surface.json');

    await extractCommand({
      sdkPath: '/some/sdk',
      lang: 'test-extract-lang',
      output: outputPath,
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Extracting test-extract-lang'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('3 symbols'));
  });
});
