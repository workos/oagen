import { describe, it, expect } from 'vitest';
import { buildConceptualRollup, highestSeverity, summarizeConceptualChanges } from '../../src/compat/concepts.js';
import type { ConceptualChange } from '../../src/compat/concepts.js';
import type { CompatDiffResult } from '../../src/compat/differ.js';
import type { ClassifiedChange } from '../../src/compat/classify.js';

function makeChange(overrides: Partial<ClassifiedChange>): ClassifiedChange {
  return {
    category: 'parameter_renamed',
    severity: 'breaking',
    symbol: 'Auth.check',
    conceptualChangeId: 'chg_param_rename',
    provenance: 'unknown',
    old: { parameter: 'resourceId' },
    new: { parameter: 'resourceTarget' },
    message: 'Parameter renamed',
    ...overrides,
  };
}

function makeDiff(language: string, changes: ClassifiedChange[]): CompatDiffResult {
  let breaking = 0,
    softRisk = 0,
    additive = 0;
  for (const c of changes) {
    if (c.severity === 'breaking') breaking++;
    else if (c.severity === 'soft-risk') softRisk++;
    else additive++;
  }
  return { changes, summary: { breaking, softRisk, additive }, language };
}

describe('buildConceptualRollup', () => {
  it('groups identical conceptualChangeId across languages', () => {
    const phpDiff = makeDiff('php', [makeChange({ severity: 'breaking' })]);
    const goDiff = makeDiff('go', [makeChange({ severity: 'soft-risk' })]);
    const pyDiff = makeDiff('python', [makeChange({ severity: 'breaking' })]);

    const rollup = buildConceptualRollup([phpDiff, goDiff, pyDiff]);
    expect(rollup.conceptualChanges).toHaveLength(1);
    expect(rollup.conceptualChanges[0].impact).toEqual({
      php: 'breaking',
      go: 'soft-risk',
      python: 'breaking',
    });
  });

  it('keeps different conceptual changes separate', () => {
    const diff = makeDiff('php', [
      makeChange({ conceptualChangeId: 'chg_a' }),
      makeChange({ conceptualChangeId: 'chg_b', symbol: 'Other.method' }),
    ]);
    const rollup = buildConceptualRollup([diff]);
    expect(rollup.conceptualChanges).toHaveLength(2);
  });

  it('handles empty input', () => {
    const rollup = buildConceptualRollup([]);
    expect(rollup.conceptualChanges).toEqual([]);
  });

  it('handles no changes in any language', () => {
    const rollup = buildConceptualRollup([makeDiff('php', []), makeDiff('go', [])]);
    expect(rollup.conceptualChanges).toEqual([]);
  });
});

describe('highestSeverity', () => {
  it('returns breaking when any language is breaking', () => {
    const change: ConceptualChange = {
      id: 'test',
      symbol: 'Auth.check',
      category: 'parameter_renamed',
      impact: { php: 'breaking', go: 'soft-risk', python: 'additive' },
      message: '',
      old: {},
      new: {},
    };
    expect(highestSeverity(change)).toBe('breaking');
  });

  it('returns soft-risk when no breaking but some soft-risk', () => {
    const change: ConceptualChange = {
      id: 'test',
      symbol: 'Auth.check',
      category: 'parameter_renamed',
      impact: { go: 'soft-risk', node: 'additive' },
      message: '',
      old: {},
      new: {},
    };
    expect(highestSeverity(change)).toBe('soft-risk');
  });

  it('returns additive when all additive', () => {
    const change: ConceptualChange = {
      id: 'test',
      symbol: 'Auth.check',
      category: 'symbol_added',
      impact: { php: 'additive', go: 'additive' },
      message: '',
      old: {},
      new: {},
    };
    expect(highestSeverity(change)).toBe('additive');
  });
});

describe('summarizeConceptualChanges', () => {
  it('counts by highest severity', () => {
    const rollup = {
      conceptualChanges: [
        {
          id: 'a',
          symbol: 'A',
          category: 'parameter_renamed' as const,
          impact: { php: 'breaking' as const },
          message: '',
          old: {},
          new: {},
        },
        {
          id: 'b',
          symbol: 'B',
          category: 'default_value_changed' as const,
          impact: { go: 'soft-risk' as const },
          message: '',
          old: {},
          new: {},
        },
        {
          id: 'c',
          symbol: 'C',
          category: 'symbol_added' as const,
          impact: { node: 'additive' as const },
          message: '',
          old: {},
          new: {},
        },
      ],
    };
    const summary = summarizeConceptualChanges(rollup);
    expect(summary).toEqual({ breaking: 1, softRisk: 1, additive: 1 });
  });
});
