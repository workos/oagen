import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');
const BEFORE = resolve(FIXTURES, 'servers-before.json');
const AFTER = resolve(FIXTURES, 'servers-after.json');
const MOVED = resolve(FIXTURES, 'servers-moved.json');

import { diffCommand } from '../../src/cli/diff.js';

/** `oagen diff` on documents that differ only in `servers` (#252). */
describe('diffCommand — servers', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  /** The JSON report the command printed. */
  function printedReport(): {
    changes: Array<{ kind: string; classification: string }>;
    summary: { breaking: number };
  } {
    const jsonCall = consoleSpy.mock.calls.find((call: unknown[]) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    return JSON.parse(jsonCall![0] as string);
  }

  it('exits 2 when a variable default moves the base URL', async () => {
    const err: any = await diffCommand({ old: BEFORE, new: AFTER }).catch((e) => e);
    expect(err.exitCode).toBe(2);

    const diff = printedReport();
    expect(diff.summary.breaking).toBe(2);
    expect(diff.changes.map((c) => c.kind)).toEqual(['base-url-changed', 'server-modified']);
    expect(diff.changes[0]).toEqual({
      kind: 'base-url-changed',
      oldBaseUrl: 'https://eu.api.example.com',
      newBaseUrl: 'https://us.api.example.com',
      classification: 'breaking',
    });
  });

  it('exits 2 when the only server is replaced', async () => {
    const err: any = await diffCommand({ old: BEFORE, new: MOVED }).catch((e) => e);
    expect(err.exitCode).toBe(2);

    const diff = printedReport();
    expect(diff.changes.map((c) => [c.kind, c.classification])).toEqual([
      ['base-url-changed', 'breaking'],
      ['server-added', 'additive'],
      ['server-removed', 'breaking'],
    ]);
  });

  it('exits 0 for the same document', async () => {
    const err: any = await diffCommand({ old: BEFORE, new: BEFORE }).catch((e) => e);
    expect(err.exitCode).toBe(0);
    expect(printedReport().changes).toEqual([]);
  });
});
