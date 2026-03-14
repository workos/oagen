import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '../../src/cli/index.ts');
const FIXTURES = resolve(__dirname, '../fixtures');

function run(args: string[], env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('npx', ['tsx', CLI, ...args], {
      env: { ...process.env, ...env, OPENAPI_SPEC_PATH: undefined },
    }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr });
    });
  });
}

describe('CLI', () => {
  describe('parse', () => {
    it('exits 1 with error when --spec is missing and OPENAPI_SPEC_PATH is unset', async () => {
      const result = await run(['parse'], { OPENAPI_SPEC_PATH: '' });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--spec <path> or OPENAPI_SPEC_PATH env var is required');
    });

    it('parses a valid spec and outputs JSON', async () => {
      const result = await run(['parse', '--spec', `${FIXTURES}/minimal.yml`]);

      expect(result.code).toBe(0);
      const ir = JSON.parse(result.stdout);
      expect(ir.name).toBe('Minimal API');
    });

    it('exits 1 when spec file does not exist', async () => {
      const result = await run(['parse', '--spec', 'nonexistent.yml']);

      expect(result.code).toBe(1);
      expect(result.stderr).not.toBe('');
    });
  });

  describe('generate', () => {
    it('exits 1 with error when --spec is missing and OPENAPI_SPEC_PATH is unset', async () => {
      const result = await run(['generate', '--lang', 'node', '--output', '/tmp/test-out'], { OPENAPI_SPEC_PATH: '' });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--spec <path> or OPENAPI_SPEC_PATH env var is required');
    });

    it('exits 1 when --lang is missing', async () => {
      const result = await run(['generate', '--spec', `${FIXTURES}/minimal.yml`, '--output', '/tmp/test-out']);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--lang');
    });

    it('exits 1 when --output is missing', async () => {
      const result = await run(['generate', '--spec', `${FIXTURES}/minimal.yml`, '--lang', 'node']);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--output');
    });

    it('--dry-run lists files without writing to disk', async () => {
      const result = await run([
        'generate',
        '--spec', `${FIXTURES}/minimal.yml`,
        '--lang', 'node',
        '--output', '/tmp/oagen-dry-run-test',
        '--dry-run',
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/\.ts/);
    });
  });
});
