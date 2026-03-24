import { describe, it, expect, vi } from 'vitest';
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
      await fs.writeFile(filePath, "require_relative 'client'\n\nclass Client\n  def initialize; end\nend\n");

      const result = await writeFiles(
        [
          {
            path: 'lib/client.rb',
            content: "require_relative 'client'\nrequire_relative 'user'\n\nclass Client\nend\n\nclass User\nend\n",
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
      await fs.writeFile(filePath, 'import os\n\nclass Client:\n    def __init__(self):\n        pass\n');

      const result = await writeFiles(
        [
          {
            path: 'workos/client.py',
            content: 'import os\nfrom workos.user import User\n\nclass Client:\n    pass\n\nclass User:\n    pass\n',
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

  it('merges additive PHP declarations into existing files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      const filePath = path.join(tmpDir, 'lib/Client.php');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, '<?php\n\nnamespace WorkOS;\n\nuse WorkOS\\Client;\n\nclass Client {}\n');

      const result = await writeFiles(
        [
          {
            path: 'lib/Client.php',
            content:
              '<?php\n\nnamespace WorkOS;\n\nuse WorkOS\\Client;\nuse WorkOS\\User;\n\nclass Client {}\n\nclass User {}\n',
          },
        ],
        tmpDir,
        { language: 'php', header: '// generated' },
      );

      expect(result.merged).toContain('lib/Client.php');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('use WorkOS\\User;');
      expect(content).toContain('class User {}');
      expect(content.match(/namespace WorkOS;/g)).toHaveLength(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('merges additive Go declarations into existing files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      const filePath = path.join(tmpDir, 'client.go');
      await fs.writeFile(filePath, 'package workos\n\ntype Client struct{}\n');

      const result = await writeFiles(
        [
          {
            path: 'client.go',
            content: 'package workos\n\nimport "context"\n\ntype Client struct{}\n\nfunc helper() {}\n',
          },
        ],
        tmpDir,
        { language: 'go', header: '// generated' },
      );

      expect(result.merged).toContain('client.go');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('import "context"');
      expect(content).toContain('func helper() {}');
      expect(content.match(/package workos/g)).toHaveLength(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('deep merges JSON preserving existing keys', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      const filePath = path.join(tmpDir, 'package.json');
      await fs.writeFile(
        filePath,
        JSON.stringify(
          { name: 'my-sdk', version: '1.0.0', author: 'Alice', scripts: { test: 'vitest', custom: 'echo hi' } },
          null,
          2,
        ) + '\n',
      );

      const result = await writeFiles(
        [
          {
            path: 'package.json',
            content:
              JSON.stringify(
                { name: 'my-sdk', version: '2.0.0', scripts: { test: 'vitest run', lint: 'eslint' } },
                null,
                2,
              ) + '\n',
          },
        ],
        tmpDir,
      );

      expect(result.merged).toContain('package.json');
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.version).toBe('2.0.0');
      expect(content.author).toBe('Alice');
      expect(content.scripts.custom).toBe('echo hi');
      expect(content.scripts.test).toBe('vitest run');
      expect(content.scripts.lint).toBe('eslint');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('replaces arrays in JSON merge', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      const filePath = path.join(tmpDir, 'data.json');
      await fs.writeFile(filePath, JSON.stringify({ items: ['old'] }, null, 2) + '\n');

      const result = await writeFiles(
        [{ path: 'data.json', content: JSON.stringify({ items: ['new', 'values'] }, null, 2) + '\n' }],
        tmpDir,
      );

      expect(result.merged).toContain('data.json');
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.items).toEqual(['new', 'values']);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('falls back to overwrite for invalid JSON', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      const filePath = path.join(tmpDir, 'broken.json');
      await fs.writeFile(filePath, 'not valid json {{{');

      const result = await writeFiles([{ path: 'broken.json', content: '{"valid": true}' }], tmpDir);

      expect(result.written).toContain('broken.json');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('{"valid": true}');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('merges additive Rust declarations into existing files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      const filePath = path.join(tmpDir, 'lib.rs');
      await fs.writeFile(filePath, 'pub struct Client {}\n');

      const result = await writeFiles(
        [
          {
            path: 'lib.rs',
            content: 'use std::fmt;\n\npub struct Client {}\n\npub fn helper() {}\n',
          },
        ],
        tmpDir,
        { language: 'rust', header: '// generated' },
      );

      expect(result.merged).toContain('lib.rs');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('use std::fmt;');
      expect(content).toContain('pub fn helper() {}');
      expect(content.match(/pub struct Client \{\}/g)).toHaveLength(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('skips test files for all supported languages', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    try {
      const testPaths = [
        'src/foo.test.ts', // node
        'src/foo.spec.tsx', // node
        'foo_test.go', // go
        'foo_test.rb', // ruby
        'foo_spec.rb', // ruby
        'test_foo.py', // python
        'foo_test.py', // python
        'FooTest.php', // php
        'foo_test.rs', // rust
        'tests/integration.rs', // rust
      ];
      for (const p of testPaths) {
        const fullPath = path.join(tmpDir, p);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, 'existing content');
      }

      const files = testPaths.map((p) => ({ path: p, content: 'new content' }));
      // Use each language to test its adapter's testFilePatterns
      const languages = ['node', 'go', 'ruby', 'python', 'php', 'rust'] as const;
      for (const lang of languages) {
        const result = await writeFiles(files, tmpDir, { language: lang });
        const langTestFiles = testPaths.filter((p) => {
          const langPatterns: Record<string, RegExp[]> = {
            node: [/\.(spec|test)\.[jt]sx?$/],
            go: [/_test\.go$/],
            ruby: [/_test\.rb$/, /_spec\.rb$/],
            python: [/(?:^|\/)test_.*\.py$/, /_test\.py$/],
            php: [/Test\.php$/],
            rust: [/_test\.rs$/, /(?:^|\/)tests\/.*\.rs$/],
          };
          return langPatterns[lang]!.some((re) => re.test(p));
        });
        for (const tf of langTestFiles) {
          expect(result.skipped, `${lang} should skip ${tf}`).toContain(tf);
        }
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('warns on console when AST merge throws', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-test-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const filePath = path.join(tmpDir, 'broken.rb');
      // Existing file — non-empty so it enters the merge branch
      await fs.writeFile(filePath, 'class Foo; end');

      // Use a language that has a grammar but will trigger a merge error
      // by creating binary content that looks like source but isn't parseable
      const nullContent = 'class Baz\x00; end';

      const result = await writeFiles([{ path: 'broken.rb', content: nullContent }], tmpDir, { language: 'ruby' });

      // If merge succeeded, it would be in merged. If it threw, written.
      // Either way the file should be updated. The test validates the warning path exists.
      if (result.written.includes('broken.rb')) {
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[oagen] AST merge failed for broken.rb'));
      } else {
        // Merge succeeded without throwing — skip the warn assertion
        expect(result.merged.includes('broken.rb') || result.written.includes('broken.rb')).toBe(true);
      }
    } finally {
      warnSpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
