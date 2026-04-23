import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import { compatSummaryCommand } from '../../src/cli/compat-summary.js';
import type { CompatReport } from '../../src/compat/report.js';

function makeReport(overrides?: Partial<CompatReport>): CompatReport {
  return {
    schemaVersion: '1',
    language: 'node',
    summary: { breaking: 0, softRisk: 0, additive: 0 },
    changes: [],
    ...overrides,
  };
}

describe('compatSummaryCommand', () => {
  let tmpDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-compat-summary-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('outputs passing markdown for clean report', async () => {
    const reportPath = resolve(tmpDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(makeReport()));

    await compatSummaryCommand({ report: reportPath });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain(':white_check_mark:');
    expect(output).toContain('No compatibility changes detected');
  });

  it('outputs failing markdown for breaking changes', async () => {
    const report = makeReport({
      summary: { breaking: 1, softRisk: 0, additive: 0 },
      changes: [
        {
          severity: 'breaking',
          category: 'symbol_removed',
          symbol: 'Client.deleteUser',
          conceptualChangeId: 'chg_1',
          provenance: 'unknown',
          old: { name: 'deleteUser' },
          new: {},
          message: 'Symbol removed',
        },
      ],
    });
    const reportPath = resolve(tmpDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report));

    await compatSummaryCommand({ report: reportPath });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain(':x:');
    expect(output).toContain('Breaking changes');
    expect(output).toContain('`symbol_removed`');
    expect(output).toContain('`Client.deleteUser`');
  });

  it('outputs warning markdown for soft-risk only', async () => {
    const report = makeReport({
      summary: { breaking: 0, softRisk: 1, additive: 0 },
      changes: [
        {
          severity: 'soft-risk',
          category: 'default_value_changed',
          symbol: 'Client.list',
          conceptualChangeId: 'chg_1',
          provenance: 'unknown',
          old: { default: '10' },
          new: { default: '20' },
          message: 'Default value changed',
        },
      ],
    });
    const reportPath = resolve(tmpDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report));

    await compatSummaryCommand({ report: reportPath });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain(':warning:');
    expect(output).toContain('Soft-risk changes');
  });

  it('collapses additive changes in details tag', async () => {
    const report = makeReport({
      summary: { breaking: 0, softRisk: 0, additive: 1 },
      changes: [
        {
          severity: 'additive',
          category: 'symbol_added',
          symbol: 'Client.newMethod',
          conceptualChangeId: 'chg_1',
          provenance: 'unknown',
          old: {},
          new: { name: 'newMethod' },
          message: 'New symbol added',
        },
      ],
    });
    const reportPath = resolve(tmpDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report));

    await compatSummaryCommand({ report: reportPath });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('<details>');
    expect(output).toContain('Additive changes (1)');
  });

  it('writes to file when --output is provided', async () => {
    const reportPath = resolve(tmpDir, 'report.json');
    const outputPath = resolve(tmpDir, 'summary.md');
    writeFileSync(reportPath, JSON.stringify(makeReport()));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await compatSummaryCommand({ report: reportPath, output: outputPath });
    consoleSpy.mockRestore();

    const written = readFileSync(outputPath, 'utf-8');
    expect(written).toContain(':white_check_mark:');
    // Should NOT have written to stdout
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('includes summary table with counts', async () => {
    const report = makeReport({
      summary: { breaking: 2, softRisk: 1, additive: 3 },
      changes: [],
    });
    const reportPath = resolve(tmpDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report));

    await compatSummaryCommand({ report: reportPath });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('| Breaking | 2 |');
    expect(output).toContain('| Soft-risk | 1 |');
    expect(output).toContain('| Additive | 3 |');
    expect(output).toContain('| **Total** | **6** |');
  });

  // -----------------------------------------------------------------------
  // Cross-language rollup (multiple --report)
  // -----------------------------------------------------------------------

  it('produces cross-language rollup from multiple reports', async () => {
    const phpReport = makeReport({
      language: 'php',
      summary: { breaking: 1, softRisk: 0, additive: 0 },
      changes: [
        {
          severity: 'breaking',
          category: 'parameter_renamed',
          symbol: 'Auth.check',
          conceptualChangeId: 'chg_param_rename_auth_check',
          provenance: 'unknown',
          old: { parameter: 'resourceId' },
          new: { parameter: 'resourceTarget' },
          message: 'Parameter renamed',
        },
      ],
    });
    const goReport = makeReport({
      language: 'go',
      summary: { breaking: 0, softRisk: 1, additive: 0 },
      changes: [
        {
          severity: 'soft-risk',
          category: 'parameter_renamed',
          symbol: 'Auth.check',
          conceptualChangeId: 'chg_param_rename_auth_check',
          provenance: 'unknown',
          old: { parameter: 'resourceId' },
          new: { parameter: 'resourceTarget' },
          message: 'Parameter renamed',
        },
      ],
    });

    const phpPath = resolve(tmpDir, 'php.json');
    const goPath = resolve(tmpDir, 'go.json');
    writeFileSync(phpPath, JSON.stringify(phpReport));
    writeFileSync(goPath, JSON.stringify(goReport));

    await compatSummaryCommand({ report: [phpPath, goPath] });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    // Should have cross-language header
    expect(output).toContain(':x:');
    expect(output).toContain('2 languages');
    // Per-language summary table
    expect(output).toContain('| php |');
    expect(output).toContain('| go |');
    // Conceptual table with per-language severity
    expect(output).toContain('`Auth.check`');
    expect(output).toContain(':x: breaking');
    expect(output).toContain(':warning: soft-risk');
  });

  it('groups same conceptual change across languages', async () => {
    const phpReport = makeReport({
      language: 'php',
      summary: { breaking: 1, softRisk: 0, additive: 0 },
      changes: [
        {
          severity: 'breaking',
          category: 'parameter_renamed',
          symbol: 'Auth.check',
          conceptualChangeId: 'chg_1',
          provenance: 'unknown',
          old: { parameter: 'resourceId' },
          new: { parameter: 'resourceTarget' },
        },
      ],
    });
    const pythonReport = makeReport({
      language: 'python',
      summary: { breaking: 1, softRisk: 0, additive: 0 },
      changes: [
        {
          severity: 'breaking',
          category: 'parameter_renamed',
          symbol: 'Auth.check',
          conceptualChangeId: 'chg_1',
          provenance: 'unknown',
          old: { parameter: 'resourceId' },
          new: { parameter: 'resourceTarget' },
        },
      ],
    });

    const phpPath = resolve(tmpDir, 'php.json');
    const pyPath = resolve(tmpDir, 'py.json');
    writeFileSync(phpPath, JSON.stringify(phpReport));
    writeFileSync(pyPath, JSON.stringify(pythonReport));

    await compatSummaryCommand({ report: [phpPath, pyPath] });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    // Should show one row for Auth.check, not two
    const authCheckMatches = output.match(/`Auth\.check`/g);
    expect(authCheckMatches).toHaveLength(1);
  });

  it('shows passing rollup when all reports are clean', async () => {
    const phpReport = makeReport({ language: 'php' });
    const goReport = makeReport({ language: 'go' });

    const phpPath = resolve(tmpDir, 'php.json');
    const goPath = resolve(tmpDir, 'go.json');
    writeFileSync(phpPath, JSON.stringify(phpReport));
    writeFileSync(goPath, JSON.stringify(goReport));

    await compatSummaryCommand({ report: [phpPath, goPath] });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain(':white_check_mark:');
    expect(output).toContain('No compatibility changes detected');
  });
});
