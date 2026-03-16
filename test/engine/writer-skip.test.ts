import { describe, it, expect } from 'vitest';
import { writeFiles } from '../../src/engine/writer.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

describe('writeFiles skipIfExists', () => {
  it('skips writing when file exists and skipIfExists is true', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-skip-'));
    try {
      // Pre-create the file with different content
      const filePath = path.join(tmpDir, 'existing.rb');
      await fs.writeFile(filePath, 'original content', 'utf-8');

      await writeFiles([{ path: 'existing.rb', content: 'new content', skipIfExists: true }], tmpDir);

      const result = await fs.readFile(filePath, 'utf-8');
      expect(result).toBe('original content');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('writes when file does not exist and skipIfExists is true', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-skip-'));
    try {
      await writeFiles([{ path: 'new-file.rb', content: 'fresh content', skipIfExists: true }], tmpDir);

      const result = await fs.readFile(path.join(tmpDir, 'new-file.rb'), 'utf-8');
      expect(result).toBe('fresh content');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('overwrites existing file when skipIfExists is not set', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-skip-'));
    try {
      const filePath = path.join(tmpDir, 'overwrite.rb');
      await fs.writeFile(filePath, 'old', 'utf-8');

      await writeFiles([{ path: 'overwrite.rb', content: 'new' }], tmpDir);

      const result = await fs.readFile(filePath, 'utf-8');
      expect(result).toBe('new');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
