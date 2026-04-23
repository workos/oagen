import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import { compatDiffCommand } from '../../src/cli/compat-diff.js';
import { COMPAT_SCHEMA_VERSION } from '../../src/compat/schema.js';
import type { CompatSnapshot } from '../../src/compat/ir.js';

function makeSnapshot(overrides?: Partial<CompatSnapshot>): CompatSnapshot {
  return {
    schemaVersion: COMPAT_SCHEMA_VERSION,
    source: { extractedAt: '2026-01-01T00:00:00.000Z' },
    policies: {
      callerUsesParamNames: false,
      constructorOrderMatters: false,
      constructorParameterNamesArePublicApi: false,
      methodParameterNamesArePublicApi: false,
      overloadsArePublicApi: true,
      arityIsPublicApi: false,
    },
    symbols: [],
    ...overrides,
  };
}

describe('compatDiffCommand', () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-compat-diff-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('diffs two identical snapshots with no changes', async () => {
    const snapshot = makeSnapshot({
      symbols: [
        {
          id: 'class:Client',
          kind: 'service_accessor',
          fqName: 'Client',
          displayName: 'Client',
          visibility: 'public',
          stability: 'stable',
          sourceKind: 'generated_service_wrapper',
        },
      ],
    });
    const baselinePath = resolve(tmpDir, 'baseline.json');
    const candidatePath = resolve(tmpDir, 'candidate.json');
    writeFileSync(baselinePath, JSON.stringify(snapshot));
    writeFileSync(candidatePath, JSON.stringify(snapshot));

    await compatDiffCommand({ baseline: baselinePath, candidate: candidatePath });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Compat report'));
    expect(process.exitCode).toBeUndefined();
  });

  it('detects symbol removal as breaking', async () => {
    const baseline = makeSnapshot({
      symbols: [
        {
          id: 'class:Removed',
          kind: 'service_accessor',
          fqName: 'Removed',
          displayName: 'Removed',
          visibility: 'public',
          stability: 'stable',
          sourceKind: 'generated_service_wrapper',
        },
      ],
    });
    const candidate = makeSnapshot({ symbols: [] });

    const baselinePath = resolve(tmpDir, 'baseline.json');
    const candidatePath = resolve(tmpDir, 'candidate.json');
    writeFileSync(baselinePath, JSON.stringify(baseline));
    writeFileSync(candidatePath, JSON.stringify(candidate));

    // Reset exitCode before test
    process.exitCode = undefined;

    await compatDiffCommand({ baseline: baselinePath, candidate: candidatePath, failOn: 'breaking' });

    expect(process.exitCode).toBe(1);

    // Clean up exitCode
    process.exitCode = undefined;
  });

  it('writes machine-readable report when --output is provided', async () => {
    const snapshot = makeSnapshot({
      symbols: [
        {
          id: 'class:Client',
          kind: 'service_accessor',
          fqName: 'Client',
          displayName: 'Client',
          visibility: 'public',
          stability: 'stable',
          sourceKind: 'generated_service_wrapper',
        },
      ],
    });
    const baselinePath = resolve(tmpDir, 'baseline.json');
    const candidatePath = resolve(tmpDir, 'candidate.json');
    const reportPath = resolve(tmpDir, 'report.json');
    writeFileSync(baselinePath, JSON.stringify(snapshot));
    writeFileSync(candidatePath, JSON.stringify(snapshot));

    await compatDiffCommand({ baseline: baselinePath, candidate: candidatePath, output: reportPath });

    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.schemaVersion).toBe('1');
    expect(report.summary).toBeDefined();
    expect(Array.isArray(report.changes)).toBe(true);
  });

  it('does not fail when failOn is none', async () => {
    const baseline = makeSnapshot({
      symbols: [
        {
          id: 'class:Removed',
          kind: 'service_accessor',
          fqName: 'Removed',
          displayName: 'Removed',
          visibility: 'public',
          stability: 'stable',
          sourceKind: 'generated_service_wrapper',
        },
      ],
    });
    const candidate = makeSnapshot({ symbols: [] });

    const baselinePath = resolve(tmpDir, 'baseline.json');
    const candidatePath = resolve(tmpDir, 'candidate.json');
    writeFileSync(baselinePath, JSON.stringify(baseline));
    writeFileSync(candidatePath, JSON.stringify(candidate));

    process.exitCode = undefined;

    await compatDiffCommand({ baseline: baselinePath, candidate: candidatePath, failOn: 'none' });

    expect(process.exitCode).toBeUndefined();
  });

  it('throws on invalid baseline snapshot', async () => {
    const baselinePath = resolve(tmpDir, 'baseline.json');
    const candidatePath = resolve(tmpDir, 'candidate.json');
    writeFileSync(baselinePath, JSON.stringify({ invalid: true }));
    writeFileSync(candidatePath, JSON.stringify(makeSnapshot()));

    await expect(compatDiffCommand({ baseline: baselinePath, candidate: candidatePath })).rejects.toThrow(
      'Invalid baseline snapshot',
    );
  });

  it('throws on invalid candidate snapshot', async () => {
    const baselinePath = resolve(tmpDir, 'baseline.json');
    const candidatePath = resolve(tmpDir, 'candidate.json');
    writeFileSync(baselinePath, JSON.stringify(makeSnapshot()));
    writeFileSync(candidatePath, JSON.stringify({ invalid: true }));

    await expect(compatDiffCommand({ baseline: baselinePath, candidate: candidatePath })).rejects.toThrow(
      'Invalid candidate snapshot',
    );
  });
});
