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

  it('creates new files in a pre-populated directory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      // Pre-populate with an existing file
      await fs.writeFile(path.join(tmpDir, 'existing.rb'), 'class Existing; end');

      const result = await writeFiles([{ path: 'new_file.rb', content: 'class NewFile; end' }], tmpDir);

      expect(result.written).toContain('new_file.rb');
      const content = await fs.readFile(path.join(tmpDir, 'new_file.rb'), 'utf-8');
      expect(content).toBe('class NewFile; end');
      // Existing file should be untouched
      const existing = await fs.readFile(path.join(tmpDir, 'existing.rb'), 'utf-8');
      expect(existing).toBe('class Existing; end');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('skips files with skipIfExists when file already exists', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'keep_me.rb'), 'original content');

      const result = await writeFiles([{ path: 'keep_me.rb', content: 'new content', skipIfExists: true }], tmpDir);

      expect(result.skipped).toContain('keep_me.rb');
      const content = await fs.readFile(path.join(tmpDir, 'keep_me.rb'), 'utf-8');
      expect(content).toBe('original content');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('reports identical files when content matches', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'same.rb'), 'class Same; end');

      const result = await writeFiles([{ path: 'same.rb', content: 'class Same; end' }], tmpDir);

      expect(result.identical).toContain('same.rb');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('running write twice produces identical results (idempotent)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      const files = [
        { path: 'lib/models/user.rb', content: 'class User; end' },
        { path: 'lib/client.rb', content: 'class Client; end' },
      ];

      const result1 = await writeFiles(files, tmpDir);
      expect(result1.written).toHaveLength(2);

      const result2 = await writeFiles(files, tmpDir);
      expect(result2.written).toHaveLength(0);
      expect(result2.identical).toHaveLength(2);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('merges additive Ruby declarations into existing files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      const filePath = path.join(tmpDir, 'lib/client.rb');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        "require_relative 'client'\n\nclass Client\n  def initialize; end\nend\n",
      );

      const result = await writeFiles(
        [
          {
            path: 'lib/client.rb',
            content:
              "require_relative 'client'\nrequire_relative 'user'\n\nclass Client\nend\n\nclass User\nend\n",
          },
        ],
        tmpDir,
        { language: 'ruby', header: '# generated' },
      );

      expect(result.merged).toContain('lib/client.rb');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain("require_relative 'user'");
      expect(content).toContain('class User');
      expect(content).toContain('def initialize');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('merges additive Python declarations into existing files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      const filePath = path.join(tmpDir, 'workos/client.py');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        'import os\n\nclass Client:\n    def __init__(self):\n        pass\n',
      );

      const result = await writeFiles(
        [
          {
            path: 'workos/client.py',
            content:
              'import os\nfrom workos.user import User\n\nclass Client:\n    pass\n\nclass User:\n    pass\n',
          },
        ],
        tmpDir,
        { language: 'python', header: '# generated' },
      );

      expect(result.merged).toContain('workos/client.py');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('from workos.user import User');
      expect(content).toContain('class User');
      expect(content).toContain('def __init__');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
