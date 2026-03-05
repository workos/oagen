import { describe, it, expect } from 'vitest';
import { writeFiles } from '../../src/engine/writer.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

describe('writeFiles', () => {
  it('creates files and directories', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      await writeFiles(
        [
          { path: 'lib/models/user.rb', content: 'class User; end' },
          { path: 'lib/client.rb', content: 'class Client; end' },
        ],
        tmpDir,
      );

      const user = await fs.readFile(path.join(tmpDir, 'lib/models/user.rb'), 'utf-8');
      expect(user).toBe('class User; end');

      const client = await fs.readFile(path.join(tmpDir, 'lib/client.rb'), 'utf-8');
      expect(client).toBe('class Client; end');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('writes files in sorted order', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      await writeFiles(
        [
          { path: 'z.rb', content: 'z' },
          { path: 'a.rb', content: 'a' },
          { path: 'm.rb', content: 'm' },
        ],
        tmpDir,
      );

      // All files should exist
      const entries = await fs.readdir(tmpDir);
      expect(entries.sort()).toEqual(['a.rb', 'm.rb', 'z.rb']);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
