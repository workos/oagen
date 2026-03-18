import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from '../../src/cli/config-loader.js';
import { applyConfig } from '../../src/cli/plugin-loader.js';
import { getEmitter } from '../../src/engine/registry.js';
import type { Emitter } from '../../src/engine/types.js';
import { ConfigLoadError, ConfigVersionMismatchError } from '../../src/errors.js';

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
    const config = await loadConfig(tmpDir);
    expect(config).toBeNull();
  });

  it('loads oagen.config.mjs and returns config object', async () => {
    writeFileSync(path.join(tmpDir, 'oagen.config.mjs'), `export default { emitterProject: '../my-emitters' };`);
    const config = await loadConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.emitterProject).toBe('../my-emitters');
  });

  it('loads smokeRunners map from config', async () => {
    writeFileSync(
      path.join(tmpDir, 'oagen.config.mjs'),
      `export default { smokeRunners: { go: './smoke/go-runner.ts', python: './smoke/py-runner.ts' } };`,
    );
    const config = await loadConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.smokeRunners).toEqual({
      go: './smoke/go-runner.ts',
      python: './smoke/py-runner.ts',
    });
  });

  it('exits with error when irVersion does not match IR_VERSION', async () => {
    writeFileSync(path.join(tmpDir, 'oagen.config.mjs'), `export default { irVersion: 9999 };`);
    await expect(loadConfig(tmpDir)).rejects.toBeInstanceOf(ConfigVersionMismatchError);
    await expect(loadConfig(tmpDir)).rejects.toThrow('IR version mismatch');
  });

  it('loads config successfully when irVersion matches', async () => {
    writeFileSync(path.join(tmpDir, 'oagen.config.mjs'), `export default { irVersion: 6 };`);
    const config = await loadConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.irVersion).toBe(6);
  });

  it('exits with error when config file exists but fails to load', async () => {
    writeFileSync(path.join(tmpDir, 'oagen.config.mjs'), `throw new Error('bad config');`);
    await expect(loadConfig(tmpDir)).rejects.toBeInstanceOf(ConfigLoadError);
    await expect(loadConfig(tmpDir)).rejects.toThrow('Failed to load oagen.config.mjs');
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
      generateConfig: () => [],
      generateTypeSignatures: () => [],
      generateTests: () => [],
      fileHeader: () => '',
    };

    applyConfig({ emitters: [mockEmitter] });

    const retrieved = getEmitter('test-lang-config');
    expect(retrieved.language).toBe('test-lang-config');
  });
});
