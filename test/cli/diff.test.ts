import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');
const V1 = resolve(FIXTURES, 'v1.yml');
const V2_ADDITIVE = resolve(FIXTURES, 'v2-additive.yml');

import { diffCommand } from '../../src/cli/diff.js';

describe('diffCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('outputs JSON diff report', async () => {
    await expect(
      diffCommand({
        old: V1,
        new: V2_ADDITIVE,
      }),
    ).rejects.toThrow();

    // Find the call that contains valid JSON (the diff report)
    const jsonCall = consoleSpy.mock.calls.find((call) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const diff = JSON.parse(jsonCall![0] as string);
    expect(diff).toHaveProperty('changes');
    expect(diff).toHaveProperty('summary');
  });

  it('exits 2 for breaking changes', async () => {
    const V2_BREAKING = resolve(FIXTURES, 'v2-breaking.yml');
    await expect(
      diffCommand({
        old: V1,
        new: V2_BREAKING,
      }),
    ).rejects.toThrow();

    const jsonCall = consoleSpy.mock.calls.find((call) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    const diff = JSON.parse(jsonCall![0] as string);
    expect(diff.summary.breaking).toBeGreaterThan(0);
  });

  it('exits 0 for no changes', async () => {
    const err: any = await diffCommand({
      old: V1,
      new: V1,
    }).catch((e) => e);

    expect(err).toBeDefined();
    expect(err.exitCode).toBe(0);
  });

  it('exits 1 for additive-only changes', async () => {
    const err: any = await diffCommand({
      old: V1,
      new: V2_ADDITIVE,
    }).catch((e) => e);

    expect(err).toBeDefined();
    expect(err.exitCode).toBe(1);
  });
});
