import { describe, it, expect } from 'vitest';
import { generate } from '../../src/engine/orchestrator.js';
import type { Emitter } from '../../src/engine/types.js';
import type { ApiSpec } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

function mockEmitter(): Emitter {
  return {
    language: 'mock',
    generateModels: () => [{ path: 'models/user.rb', content: 'class User; end' }],
    generateEnums: () => [],
    generateResources: () => [],
    generateClient: () => [{ path: 'client.rb', content: 'class Client; end' }],
    generateErrors: () => [],
    generateTypeSignatures: () => [],
    generateTests: () => [],
    fileHeader: () => '# Auto-generated',
  };
}

const minimalSpec: ApiSpec = {
  name: 'Test API',
  version: '1.0.0',
  baseUrl: 'https://api.test.com',
  services: [],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

describe('generate — non-dry-run', () => {
  it('writes files to disk when dryRun is false', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-orch-'));
    try {
      const files = await generate(minimalSpec, mockEmitter(), {
        namespace: 'test',
        dryRun: false,
        outputDir: tmpDir,
      });

      expect(files.length).toBeGreaterThan(0);

      // Files should actually exist on disk
      const userFile = await fs.readFile(path.join(tmpDir, 'models/user.rb'), 'utf-8');
      expect(userFile).toContain('Auto-generated');
      expect(userFile).toContain('class User; end');

      const clientFile = await fs.readFile(path.join(tmpDir, 'client.rb'), 'utf-8');
      expect(clientFile).toContain('class Client; end');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
