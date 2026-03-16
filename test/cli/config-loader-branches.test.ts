import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from '../../src/cli/config-loader.js';

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
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await loadConfig(tmpDir);
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('TypeScript config files require'));
    } finally {
      mockExit.mockRestore();
      mockError.mockRestore();
    }
  });
});
