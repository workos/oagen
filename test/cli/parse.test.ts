import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');
const MINIMAL_SPEC = resolve(FIXTURES, 'minimal.yml');

import { parseCommand } from '../../src/cli/parse.js';

describe('parseCommand', () => {
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => {
    consoleSpy.mockClear();
    errorSpy.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('outputs IR JSON for a valid spec', async () => {
    await parseCommand({ spec: MINIMAL_SPEC });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls[0]![0] as string;
    const ir = JSON.parse(output);
    expect(ir.name).toBe('Minimal API');
    expect(ir.models.length).toBeGreaterThan(0);
  });

  it('exits 1 when spec file does not exist', async () => {
    // parseCommand calls process.exit(1) on error, which vitest intercepts
    await expect(parseCommand({ spec: '/nonexistent/spec.yml' })).rejects.toThrow(/process\.exit/);
  });
});
