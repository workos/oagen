import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from '../../src/cli/config-loader.js';
import { applyConfig } from '../../src/cli/plugin-loader.js';
import { getEmitter } from '../../src/engine/registry.js';
import type { Emitter } from '../../src/engine/types.js';
import { ConfigLoadError } from '../../src/errors.js';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `oagen-config-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no config file exists', async () => {
    const config = await loadConfig(undefined, tmpDir);
    expect(config).toBeNull();
  });

  it('loads oagen.config.mjs and returns config object', async () => {
    writeFileSync(path.join(tmpDir, 'oagen.config.mjs'), `export default { emitterProject: '../my-emitters' };`);
    const config = await loadConfig(undefined, tmpDir);
    expect(config).not.toBeNull();
    expect(config!.emitterProject).toBe('../my-emitters');
  });

  it('loads smokeRunners map from config', async () => {
    writeFileSync(
      path.join(tmpDir, 'oagen.config.mjs'),
      `export default { smokeRunners: { go: './smoke/go-runner.ts', python: './smoke/py-runner.ts' } };`,
    );
    const config = await loadConfig(undefined, tmpDir);
    expect(config).not.toBeNull();
    expect(config!.smokeRunners).toEqual({
      go: './smoke/go-runner.ts',
      python: './smoke/py-runner.ts',
    });
  });

  it('exits with error when config file exists but fails to load', async () => {
    writeFileSync(path.join(tmpDir, 'oagen.config.mjs'), `throw new Error('bad config');`);
    await expect(loadConfig(undefined, tmpDir)).rejects.toBeInstanceOf(ConfigLoadError);
    await expect(loadConfig(undefined, tmpDir)).rejects.toThrow('Failed to load oagen.config.mjs');
  });

  it('loads an explicit config path', async () => {
    const configFile = path.join(tmpDir, 'custom.config.mjs');
    writeFileSync(configFile, `export default { docUrl: 'https://example.com' };`);
    const config = await loadConfig(configFile);
    expect(config).not.toBeNull();
    expect(config!.docUrl).toBe('https://example.com');
  });

  it('loads an explicit config path relative to cwd', async () => {
    writeFileSync(path.join(tmpDir, 'my-config.mjs'), `export default { docUrl: 'https://relative.test' };`);
    const config = await loadConfig('my-config.mjs', tmpDir);
    expect(config).not.toBeNull();
    expect(config!.docUrl).toBe('https://relative.test');
  });

  it('throws ConfigLoadError when explicit config path does not exist', async () => {
    await expect(loadConfig(path.join(tmpDir, 'missing.mjs'))).rejects.toBeInstanceOf(ConfigLoadError);
    await expect(loadConfig(path.join(tmpDir, 'missing.mjs'))).rejects.toThrow('Config file not found');
  });

  it('throws ConfigLoadError when explicit config file fails to load', async () => {
    const configFile = path.join(tmpDir, 'broken.mjs');
    writeFileSync(configFile, `throw new Error('broken');`);
    await expect(loadConfig(configFile)).rejects.toBeInstanceOf(ConfigLoadError);
    await expect(loadConfig(configFile)).rejects.toThrow('Failed to load');
  });
});

describe('applyConfig', () => {
  it('registers emitters from config', () => {
    const mockEmitter: Emitter = {
      language: 'test-lang-config',
      generateModels: () => [],
      generateEnums: () => [],
      generateResources: () => [],
      generateClient: () => [],
      generateErrors: () => [],
      generateTypeSignatures: () => [],
      generateTests: () => [],
      fileHeader: () => '',
    };

    applyConfig({ emitters: [mockEmitter] });

    const retrieved = getEmitter('test-lang-config');
    expect(retrieved.language).toBe('test-lang-config');
  });
});
