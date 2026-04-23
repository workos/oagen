import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from '../../src/cli/config-loader.js';
import { ConfigLoadError } from '../../src/errors.js';

describe('loadConfig — .ts config hint', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `oagen-config-ts-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows TypeScript hint when .ts config file fails to load', async () => {
    writeFileSync(path.join(tmpDir, 'oagen.config.ts'), `throw new Error('ts config broken');`);
    await expect(loadConfig(undefined, tmpDir)).rejects.toBeInstanceOf(ConfigLoadError);
    await expect(loadConfig(undefined, tmpDir)).rejects.toThrow('TypeScript config files require');
  });
});
