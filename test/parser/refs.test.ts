import { describe, it, expect } from 'vitest';
import { loadAndBundleSpec } from '../../src/parser/refs.js';

describe('loadAndBundleSpec', () => {
  it('throws when file does not exist', async () => {
    await expect(loadAndBundleSpec('/nonexistent/spec.yml')).rejects.toThrow();
  });

  it('throws for invalid YAML content', async () => {
    // Create a temp file with invalid content
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const os = await import('node:os');

    const tmpDir = join(os.tmpdir(), `oagen-refs-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const specPath = join(tmpDir, 'bad.yml');
    writeFileSync(specPath, ': : : invalid yaml [[[');

    try {
      await expect(loadAndBundleSpec(specPath)).rejects.toThrow();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
