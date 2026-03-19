import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';

import { initCommand } from '../../src/cli/init.js';

describe('initCommand', () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-init-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
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

  it('aborts if oagen.config.ts already exists', async () => {
    writeFileSync(resolve(tmpDir, 'oagen.config.ts'), '{}');

    await expect(initCommand({ lang: 'ruby', project: tmpDir })).rejects.toThrow('Project already initialized');
  });

  it('substitutes language in package.json', async () => {
    await initCommand({ lang: 'go', project: tmpDir });

    const pkg = JSON.parse(readFileSync(resolve(tmpDir, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('custom-oagen-emitters');
    expect(pkg.scripts['sdk:generate:go']).toContain('--lang go');
    expect(pkg.scripts['sdk:verify:go']).toContain('--lang go');
    expect(pkg.scripts['sdk:extract:go']).toContain('--lang go');
  });

  it('stub emitter has all Emitter methods and no contractVersion', async () => {
    await initCommand({ lang: 'ruby', project: tmpDir });

    const content = readFileSync(resolve(tmpDir, 'src/ruby/index.ts'), 'utf-8');
    expect(content).not.toContain('IR_VERSION');
    expect(content).not.toContain('contractVersion');
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

  it('appends scripts to existing package.json without overwriting', async () => {
    // Create an existing package.json
    const existingPkg = {
      name: 'my-existing-project',
      version: '1.0.0',
      scripts: {
        build: 'tsc',
        test: 'jest',
        'sdk:generate:python': 'existing-script',
      },
    };
    writeFileSync(resolve(tmpDir, 'package.json'), JSON.stringify(existingPkg, null, 2));

    await initCommand({ lang: 'go', project: tmpDir });

    const pkg = JSON.parse(readFileSync(resolve(tmpDir, 'package.json'), 'utf-8'));

    // Original properties preserved
    expect(pkg.name).toBe('my-existing-project');
    expect(pkg.version).toBe('1.0.0');

    // Original scripts preserved
    expect(pkg.scripts.build).toBe('tsc');
    expect(pkg.scripts.test).toBe('jest');

    // New oagen scripts added
    expect(pkg.scripts['sdk:generate:go']).toContain('--lang go');
    expect(pkg.scripts['sdk:verify:go']).toContain('--lang go');
    expect(pkg.scripts['sdk:extract:go']).toContain('--lang go');

    // Existing oagen script with same key gets overwritten
    expect(pkg.scripts['sdk:generate:python']).toBe('existing-script');
  });

  it('merges devDependencies, dependencies, exports, and type from template', async () => {
    // Create an existing package.json with some overlapping deps
    const existingPkg = {
      name: 'my-existing-project',
      version: '2.0.0',
      scripts: { build: 'tsc' },
      devDependencies: {
        tsup: '^7.0.0', // older version, should be overwritten
        'existing-dep': '^1.0.0',
      },
      dependencies: {
        '@workos/oagen': '^0.0.5', // older version, should be overwritten
        'another-dep': '^2.0.0',
      },
    };
    writeFileSync(resolve(tmpDir, 'package.json'), JSON.stringify(existingPkg, null, 2));

    await initCommand({ lang: 'ruby', project: tmpDir });

    const pkg = JSON.parse(readFileSync(resolve(tmpDir, 'package.json'), 'utf-8'));

    // Type should be set
    expect(pkg.type).toBe('module');

    // Exports should be added
    expect(pkg.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    });

    // devDependencies merged (existing takes precedence for tsup, new ones added)
    expect(pkg.devDependencies['existing-dep']).toBe('^1.0.0');
    expect(pkg.devDependencies.tsx).toBe('^4.19.0');
    expect(pkg.devDependencies.vitest).toBe('^3.0.0');

    // dependencies merged (existing takes precedence)
    expect(pkg.dependencies['another-dep']).toBe('^2.0.0');
    expect(pkg.dependencies['@workos/oagen']).toBe('^0.0.5');
  });

  it('appends to existing .gitignore without overwriting', async () => {
    // Create an existing .gitignore
    const existingGitignore = `node_modules/
.env
coverage/
# Custom entries
custom-dir/
`;
    writeFileSync(resolve(tmpDir, '.gitignore'), existingGitignore);

    await initCommand({ lang: 'python', project: tmpDir });

    const gitignoreContent = readFileSync(resolve(tmpDir, '.gitignore'), 'utf-8');

    // Original entries preserved
    expect(gitignoreContent).toContain('node_modules/');
    expect(gitignoreContent).toContain('.env');
    expect(gitignoreContent).toContain('coverage/');
    expect(gitignoreContent).toContain('custom-dir/');

    // New oagen entries added
    expect(gitignoreContent).toContain('dist/');
    expect(gitignoreContent).toContain('sdk-*-surface.json');
    expect(gitignoreContent).toContain('smoke-*.json');
    expect(gitignoreContent).toContain('sdk/');
  });

  it('does not duplicate entries in .gitignore', async () => {
    // Create an existing .gitignore with some overlapping entries
    const existingGitignore = `node_modules/
dist/
.env
`;
    writeFileSync(resolve(tmpDir, '.gitignore'), existingGitignore);

    await initCommand({ lang: 'go', project: tmpDir });

    const gitignoreContent = readFileSync(resolve(tmpDir, '.gitignore'), 'utf-8');

    // Count occurrences of node_modules/ and dist/
    const nodeModulesCount = (gitignoreContent.match(/node_modules\//g) || []).length;
    const distCount = (gitignoreContent.match(/dist\//g) || []).length;

    expect(nodeModulesCount).toBe(1);
    expect(distCount).toBe(1);
  });
});
