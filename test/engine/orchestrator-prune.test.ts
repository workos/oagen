import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generate } from '../../src/engine/orchestrator.js';
import { readManifest, MANIFEST_FILENAME } from '../../src/engine/manifest.js';
import type { Emitter } from '../../src/engine/types.js';
import type { ApiSpec } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

const HEADER = '# Auto-generated';

function mockEmitter(files: { path: string; content: string }[]): Emitter {
  return {
    language: 'mock',
    generateModels: () => files.filter((f) => f.path.startsWith('models/')),
    generateEnums: () => [],
    generateResources: () => [],
    generateClient: () => files.filter((f) => !f.path.startsWith('models/')),
    generateErrors: () => [],
    generateTypeSignatures: () => [],
    generateTests: () => [],
    fileHeader: () => HEADER,
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

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'oagen-prune-'));
}

describe('orchestrator — manifest-based pruning', () => {
  it('writes a manifest on first run (no prior manifest present)', async () => {
    const outputDir = await tmp();
    try {
      const emitter = mockEmitter([
        { path: 'models/user.rb', content: 'class User; end' },
        { path: 'client.rb', content: 'class Client; end' },
      ]);

      await generate(minimalSpec, emitter, { namespace: 'test', outputDir });

      const manifest = await readManifest(outputDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.language).toBe('mock');
      expect(manifest!.files).toEqual(['client.rb', 'models/user.rb']);
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });

  it('prunes files recorded in prior manifest but absent in new run', async () => {
    const outputDir = await tmp();
    try {
      // Run 1: emits user.rb + client.rb
      await generate(
        minimalSpec,
        mockEmitter([
          { path: 'models/user.rb', content: 'class User; end' },
          { path: 'client.rb', content: 'class Client; end' },
        ]),
        { namespace: 'test', outputDir },
      );

      expect(await fileExists(path.join(outputDir, 'models/user.rb'))).toBe(true);

      // Run 2: emits only client.rb — user.rb should be pruned
      await generate(minimalSpec, mockEmitter([{ path: 'client.rb', content: 'class Client; end' }]), {
        namespace: 'test',
        outputDir,
      });

      expect(await fileExists(path.join(outputDir, 'models/user.rb'))).toBe(false);
      expect(await fileExists(path.join(outputDir, 'client.rb'))).toBe(true);

      const manifest = await readManifest(outputDir);
      expect(manifest!.files).toEqual(['client.rb']);
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });

  it('preserves files in prior manifest that no longer have the auto-generated header', async () => {
    const outputDir = await tmp();
    try {
      await generate(minimalSpec, mockEmitter([{ path: 'models/user.rb', content: 'class User; end' }]), {
        namespace: 'test',
        outputDir,
      });

      // Simulate hand-edit: header removed
      await fs.writeFile(path.join(outputDir, 'models/user.rb'), 'class User\n  def hand_written; end\nend\n');

      // Run 2: emitter no longer emits user.rb
      await generate(minimalSpec, mockEmitter([{ path: 'client.rb', content: 'class Client; end' }]), {
        namespace: 'test',
        outputDir,
      });

      // File should be preserved because it's missing the header
      expect(await fileExists(path.join(outputDir, 'models/user.rb'))).toBe(true);
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });

  it('skips pruning entirely when --no-prune is set, but still refreshes the manifest', async () => {
    const outputDir = await tmp();
    try {
      await generate(minimalSpec, mockEmitter([{ path: 'models/user.rb', content: 'class User; end' }]), {
        namespace: 'test',
        outputDir,
      });

      await generate(minimalSpec, mockEmitter([{ path: 'client.rb', content: 'class Client; end' }]), {
        namespace: 'test',
        outputDir,
        noPrune: true,
      });

      // user.rb should still be present because pruning was skipped
      expect(await fileExists(path.join(outputDir, 'models/user.rb'))).toBe(true);

      // Manifest should reflect the latest emission (baseline for future prune-enabled runs)
      const manifest = await readManifest(outputDir);
      expect(manifest!.files).toEqual(['client.rb']);
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });

  it('does not prune on first adoption even when previous files exist (no manifest → no baseline)', async () => {
    const outputDir = await tmp();
    try {
      // Pre-seed a file that would look stale if there were a manifest pointing to it
      await fs.writeFile(path.join(outputDir, 'legacy.rb'), `${HEADER}\nclass Legacy; end\n`);

      await generate(minimalSpec, mockEmitter([{ path: 'client.rb', content: 'class Client; end' }]), {
        namespace: 'test',
        outputDir,
      });

      // Without a previous manifest, legacy.rb is not claimed by the emitter and must not be touched
      expect(await fileExists(path.join(outputDir, 'legacy.rb'))).toBe(true);
      // Manifest should now exist and list only the current emission
      const manifest = await readManifest(outputDir);
      expect(manifest!.files).toEqual(['client.rb']);
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });

  it('writes the manifest at the MANIFEST_FILENAME path', async () => {
    const outputDir = await tmp();
    try {
      await generate(minimalSpec, mockEmitter([{ path: 'client.rb', content: 'class Client; end' }]), {
        namespace: 'test',
        outputDir,
      });
      expect(await fileExists(path.join(outputDir, MANIFEST_FILENAME))).toBe(true);
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
