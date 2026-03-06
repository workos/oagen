import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { diffSpecs } from '../../src/differ/diff.js';

const fixtures = resolve(import.meta.dirname, '../fixtures');

describe('integration: diff YAML fixtures', () => {
  it('v1 vs v1 → 0 changes', async () => {
    const v1 = await parseSpec(resolve(fixtures, 'v1.yml'));
    const diff = diffSpecs(v1, v1);
    expect(diff.changes).toHaveLength(0);
    expect(diff.summary.breaking).toBe(0);
    expect(diff.summary.additive).toBe(0);
  });

  it('v1 vs v2-additive → all additive, no breaking', async () => {
    const v1 = await parseSpec(resolve(fixtures, 'v1.yml'));
    const v2 = await parseSpec(resolve(fixtures, 'v2-additive.yml'));
    const diff = diffSpecs(v1, v2);
    expect(diff.changes.length).toBeGreaterThan(0);
    expect(diff.summary.breaking).toBe(0);
    expect(diff.changes.every((c) => c.classification === 'additive')).toBe(true);
  });

  it('v1 vs v2-breaking → has breaking changes', async () => {
    const v1 = await parseSpec(resolve(fixtures, 'v1.yml'));
    const v2 = await parseSpec(resolve(fixtures, 'v2-breaking.yml'));
    const diff = diffSpecs(v1, v2);
    expect(diff.changes.length).toBeGreaterThan(0);
    expect(diff.summary.breaking).toBeGreaterThan(0);
  });

  it('v1 vs v2-mixed → has both additive and breaking', async () => {
    const v1 = await parseSpec(resolve(fixtures, 'v1.yml'));
    const v2 = await parseSpec(resolve(fixtures, 'v2-mixed.yml'));
    const diff = diffSpecs(v1, v2);
    expect(diff.changes.length).toBeGreaterThan(0);
    expect(diff.summary.additive).toBeGreaterThan(0);
    expect(diff.summary.breaking).toBeGreaterThan(0);
  });
});
