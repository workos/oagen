import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generate } from '../../src/engine/orchestrator.js';
import type { Emitter, EmitterContext } from '../../src/engine/types.js';
import type { ApiSpec } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

function mockEmitter(): Emitter {
  return {
    language: 'mock',
    generateModels: () => [{ path: 'models/user.rb', content: 'class User; end' }],
    generateEnums: () => [{ path: 'models/status.rb', content: 'class Status; end' }],
    generateResources: () => [{ path: 'resources/users.rb', content: 'class Users; end' }],
    generateClient: () => [{ path: 'client.rb', content: 'class Client; end' }],
    generateErrors: () => [{ path: 'errors.rb', content: 'class APIError; end' }],
    generateTypeSignatures: () => [{ path: 'sig/user.rbs', content: 'class User; end' }],
    generateTests: () => [{ path: 'test/test_users.rb', content: 'class TestUsers; end' }],
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

describe('generate', () => {
  it('calls all emitter methods and collects files', async () => {
    const files = await generate(minimalSpec, mockEmitter(), {
      namespace: 'test_api',
      dryRun: true,
      outputDir: '/tmp/test',
    });

    expect(files).toHaveLength(7);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('models/user.rb');
    expect(paths).toContain('models/status.rb');
    expect(paths).toContain('resources/users.rb');
    expect(paths).toContain('client.rb');
    expect(paths).toContain('errors.rb');
    expect(paths).toContain('sig/user.rbs');
    expect(paths).toContain('test/test_users.rb');
  });

  it('prepends file header to all non-JSON files', async () => {
    const files = await generate(minimalSpec, mockEmitter(), {
      namespace: 'test',
      dryRun: true,
      outputDir: '/tmp/test',
    });

    for (const f of files) {
      if (f.path.endsWith('.json')) {
        expect(f.content).not.toMatch(/^# Auto-generated/);
      } else {
        expect(f.content).toMatch(/^# Auto-generated\n\n/);
      }
    }
  });

  it('sets namespace context from options', async () => {
    let capturedCtx: EmitterContext | undefined;
    const emitter = mockEmitter();
    emitter.generateModels = (_models, ctx) => {
      capturedCtx = ctx;
      return [];
    };

    await generate(minimalSpec, emitter, {
      namespace: 'WorkOS',
      dryRun: true,
      outputDir: '/tmp/test',
    });

    expect(capturedCtx!.namespace).toBe('work_os');
    expect(capturedCtx!.namespacePascal).toBe('WorkOS');
    expect(capturedCtx!.spec).toBe(minimalSpec);
  });

  it('dry run does not write files', async () => {
    const files = await generate(minimalSpec, mockEmitter(), {
      namespace: 'test',
      dryRun: true,
      outputDir: '/tmp/nonexistent-dir-that-should-not-be-created',
    });

    expect(files.length).toBeGreaterThan(0);
  });

  it('writes to both outputDir and target when target is set', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-out-'));
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-target-'));
    try {
      await generate(minimalSpec, mockEmitter(), {
        namespace: 'test',
        outputDir,
        target: targetDir,
      });

      // Output dir should have language-prefixed files
      const outputFile = await fs.readFile(path.join(outputDir, 'client.rb'), 'utf-8');
      expect(outputFile).toMatch(/^# Auto-generated/);

      // Target dir should have files without language prefix
      const targetFile = await fs.readFile(path.join(targetDir, 'client.rb'), 'utf-8');
      expect(targetFile).toMatch(/^# Auto-generated/);
    } finally {
      await fs.rm(outputDir, { recursive: true });
      await fs.rm(targetDir, { recursive: true });
    }
  });

  it('strips language prefix from target file paths', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-out-'));
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-target-'));
    try {
      await generate(minimalSpec, mockEmitter(), {
        namespace: 'test',
        outputDir,
        target: targetDir,
      });

      // Target gets the same paths as output (no language prefix)
      const entries = await fs.readdir(targetDir, { recursive: true });
      const paths = entries.map(String);
      expect(paths).toContain('client.rb');
    } finally {
      await fs.rm(outputDir, { recursive: true });
      await fs.rm(targetDir, { recursive: true });
    }
  });

  it('dry run with target does not write to target', async () => {
    const targetDir = path.join(os.tmpdir(), 'oagen-target-dryrun-should-not-exist');
    const files = await generate(minimalSpec, mockEmitter(), {
      namespace: 'test',
      dryRun: true,
      outputDir: '/tmp/nonexistent',
      target: targetDir,
    });

    expect(files.length).toBeGreaterThan(0);
    // Target directory should not exist
    await expect(fs.access(targetDir)).rejects.toThrow();
  });

  it('without target behaves exactly as before', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-out-'));
    try {
      const files = await generate(minimalSpec, mockEmitter(), {
        namespace: 'test',
        outputDir,
      });

      expect(files).toHaveLength(7);
      // Only output dir should have files
      const outputFile = await fs.readFile(path.join(outputDir, 'client.rb'), 'utf-8');
      expect(outputFile).toMatch(/^# Auto-generated/);
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });

  it('does not prepend header when headerPlacement is skip', async () => {
    const emitter = mockEmitter();
    emitter.generateModels = () => [{ path: 'models/user.rb', content: 'class User; end', headerPlacement: 'skip' }];

    const files = await generate(minimalSpec, emitter, {
      namespace: 'test',
      dryRun: true,
      outputDir: '/tmp/test',
    });

    const modelFile = files.find((f) => f.path === 'models/user.rb');
    expect(modelFile).toBeDefined();
    expect(modelFile!.content).toBe('class User; end');
    expect(modelFile!.content).not.toMatch(/^# Auto-generated/);
  });

  it('still works when generateTypeSignatures is omitted from emitter', async () => {
    const emitter = mockEmitter();
    delete (emitter as Partial<Emitter>).generateTypeSignatures;

    const files = await generate(minimalSpec, emitter, {
      namespace: 'test',
      dryRun: true,
      outputDir: '/tmp/test',
    });

    // Should still return files from all other methods
    expect(files.length).toBeGreaterThan(0);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('models/user.rb');
    expect(paths).toContain('client.rb');
    // No type signature files since the method was omitted
    expect(paths).not.toContain('sig/user.rbs');
  });
});
