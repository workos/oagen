import { describe, it, expect } from 'vitest';
import {
  generateReport,
  formatHumanSummary,
  generateConceptualReport,
  formatConceptualSummary,
} from '../../src/compat/report.js';
import type { CompatDiffResult } from '../../src/compat/differ.js';
import type { ClassifiedChange } from '../../src/compat/classify.js';

function makeChange(overrides: Partial<ClassifiedChange>): ClassifiedChange {
  return {
    category: 'parameter_renamed',
    severity: 'breaking',
    symbol: 'Auth.check',
    conceptualChangeId: 'chg_parameter_renamed_auth.check_resourceid',
    provenance: 'spec_shape_change',
    old: { parameter: 'resourceId' },
    new: { parameter: 'resourceTarget' },
    message: 'Parameter renamed on Auth.check',
    ...overrides,
  };
}

function makeDiffResult(changes: ClassifiedChange[]): CompatDiffResult {
  let breaking = 0,
    softRisk = 0,
    additive = 0;
  for (const c of changes) {
    if (c.severity === 'breaking') breaking++;
    else if (c.severity === 'soft-risk') softRisk++;
    else additive++;
  }
  return { changes, summary: { breaking, softRisk, additive } };
}

describe('generateReport', () => {
  it('produces a machine-readable report with correct schema', () => {
    const diff = makeDiffResult([makeChange({})]);
    const report = generateReport(diff, 'php');
    expect(report.schemaVersion).toBe('1');
    expect(report.language).toBe('php');
    expect(report.summary.breaking).toBe(1);
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0].category).toBe('parameter_renamed');
    expect(report.changes[0].provenance).toBe('spec_shape_change');
  });

  it('produces empty report for no changes', () => {
    const diff = makeDiffResult([]);
    const report = generateReport(diff);
    expect(report.changes).toEqual([]);
    expect(report.summary).toEqual({ breaking: 0, softRisk: 0, additive: 0 });
  });

  it('passes remediation hints through to the machine-readable change entry', () => {
    const diff = makeDiffResult([makeChange({ remediation: 'Consider extending Foo instead of forking FooWithBar.' })]);
    const report = generateReport(diff);
    expect(report.changes[0].remediation).toBe('Consider extending Foo instead of forking FooWithBar.');
  });

  it('omits remediation key when no hint was set', () => {
    const diff = makeDiffResult([makeChange({})]);
    const report = generateReport(diff);
    expect(report.changes[0]).not.toHaveProperty('remediation');
  });
});

describe('formatHumanSummary', () => {
  it('includes language and severity counts', () => {
    const diff = makeDiffResult([
      makeChange({ severity: 'breaking' }),
      makeChange({ severity: 'soft-risk', category: 'default_value_changed', symbol: 'Auth.other' }),
      makeChange({ severity: 'additive', category: 'symbol_added', symbol: 'Auth.new' }),
    ]);
    const output = formatHumanSummary(diff, { language: 'php' });
    expect(output).toContain('php');
    expect(output).toContain('1 breaking');
    expect(output).toContain('1 soft-risk');
    expect(output).toContain('1 additive');
  });

  it('includes provenance when explain is true', () => {
    const diff = makeDiffResult([makeChange({ provenance: 'emitter_template_change' })]);
    const output = formatHumanSummary(diff, { explain: true });
    expect(output).toContain('emitter_template_change');
  });

  it('omits provenance when explain is false', () => {
    const diff = makeDiffResult([makeChange({ provenance: 'emitter_template_change' })]);
    const output = formatHumanSummary(diff, { explain: false });
    expect(output).not.toContain('provenance:');
  });

  it('surfaces remediation hints in the human summary regardless of explain', () => {
    const diff = makeDiffResult([makeChange({ remediation: 'Consider extending Foo instead of forking FooWithBar.' })]);
    const output = formatHumanSummary(diff, { explain: false });
    expect(output).toContain('hint: Consider extending Foo instead of forking FooWithBar.');
  });
});

describe('generateConceptualReport', () => {
  it('groups same conceptualChangeId across languages', () => {
    const phpDiff = makeDiffResult([makeChange({})]);
    const pyDiff = makeDiffResult([makeChange({})]);
    const report = generateConceptualReport([
      { diff: phpDiff, language: 'php' },
      { diff: pyDiff, language: 'python' },
    ]);
    expect(report.conceptualChanges).toHaveLength(1);
    expect(report.conceptualChanges[0].impact).toEqual({
      php: 'breaking',
      python: 'breaking',
    });
  });

  it('keeps different conceptual changes separate', () => {
    const phpDiff = makeDiffResult([
      makeChange({ conceptualChangeId: 'chg_a' }),
      makeChange({ conceptualChangeId: 'chg_b', symbol: 'Other.method' }),
    ]);
    const report = generateConceptualReport([{ diff: phpDiff, language: 'php' }]);
    expect(report.conceptualChanges).toHaveLength(2);
  });
});

describe('formatConceptualSummary', () => {
  it('includes per-language impact', () => {
    const phpDiff = makeDiffResult([makeChange({})]);
    const goDiff = makeDiffResult([makeChange({ severity: 'soft-risk' })]);
    const output = formatConceptualSummary([
      { diff: phpDiff, language: 'php' },
      { diff: goDiff, language: 'go' },
    ]);
    expect(output).toContain('php: breaking');
    expect(output).toContain('go: soft-risk');
  });
});
