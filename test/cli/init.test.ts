import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { initCommand } from '../../src/cli/init.js';

describe('initCommand', () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-init-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates all scaffold files for a given language', async () => {
    await initCommand({ lang: 'ruby', project: tmpDir });

    const expectedFiles = [
      'package.json',
      'tsconfig.json',
      'vitest.config.ts',
      'tsup.config.ts',
      'oagen.config.ts',
      'src/index.ts',
      '.gitignore',
      'src/ruby/index.ts',
    ];

    for (const file of expectedFiles) {
      expect(existsSync(resolve(tmpDir, file)), `${file} should exist`).toBe(true);
    }
  });

  it('creates required directories', async () => {
    await initCommand({ lang: 'ruby', project: tmpDir });

    const expectedDirs = ['test', 'smoke', 'docs/sdk-architecture'];
    for (const dir of expectedDirs) {
      expect(existsSync(resolve(tmpDir, dir)), `${dir}/ should exist`).toBe(true);
    }
  });

  it('aborts if package.json already exists', async () => {
    writeFileSync(resolve(tmpDir, 'package.json'), '{}');

    await expect(initCommand({ lang: 'ruby', project: tmpDir })).rejects.toThrow('Project already initialized');
  });

  it('substitutes language in package.json', async () => {
    await initCommand({ lang: 'go', project: tmpDir });

    const pkg = JSON.parse(readFileSync(resolve(tmpDir, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('@workos/oagen-emitters-go');
    expect(pkg.scripts['sdk:generate']).toContain('--lang go');
    expect(pkg.scripts['sdk:verify']).toContain('--lang go');
    expect(pkg.scripts['sdk:extract']).toContain('--lang go');
  });

  it('stub emitter references IR_VERSION and has all Emitter methods', async () => {
    await initCommand({ lang: 'ruby', project: tmpDir });

    const content = readFileSync(resolve(tmpDir, 'src/ruby/index.ts'), 'utf-8');
    expect(content).toContain('IR_VERSION');
    expect(content).toContain('contractVersion: IR_VERSION');
    expect(content).toContain('generateModels');
    expect(content).toContain('generateEnums');
    expect(content).toContain('generateResources');
    expect(content).toContain('generateClient');
    expect(content).toContain('generateErrors');
    expect(content).toContain('generateConfig');
    expect(content).toContain('generateTests');
    expect(content).toContain('fileHeader');
    expect(content).toContain('rubyEmitter');
  });

  it('oagen.config.ts imports and registers the stub', async () => {
    await initCommand({ lang: 'ruby', project: tmpDir });

    const content = readFileSync(resolve(tmpDir, 'oagen.config.ts'), 'utf-8');
    expect(content).toContain("import { rubyEmitter } from './src/ruby/index.js'");
    expect(content).toContain('emitters: [rubyEmitter]');
  });

  it('src/index.ts re-exports the emitter', async () => {
    await initCommand({ lang: 'ruby', project: tmpDir });

    const content = readFileSync(resolve(tmpDir, 'src/index.ts'), 'utf-8');
    expect(content).toContain("export { rubyEmitter } from './ruby/index.js'");
  });

  it('uses camelCase for multi-word language names', async () => {
    await initCommand({ lang: 'objective-c', project: tmpDir });

    const emitterContent = readFileSync(resolve(tmpDir, 'src/objective-c/index.ts'), 'utf-8');
    expect(emitterContent).toContain('objectiveCEmitter');

    const configContent = readFileSync(resolve(tmpDir, 'oagen.config.ts'), 'utf-8');
    expect(configContent).toContain('objectiveCEmitter');
  });

  it('defaults project to current directory', async () => {
    const subDir = resolve(tmpDir, 'sub');
    mkdirSync(subDir, { recursive: true });

    // Change cwd temporarily
    const origCwd = process.cwd();
    process.chdir(subDir);
    try {
      await initCommand({ lang: 'python' });
      expect(existsSync(resolve(subDir, 'package.json'))).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });
});
