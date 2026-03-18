import { describe, it, expect } from 'vitest';
import { deepMergeJson } from '../../src/engine/json-merge.js';

describe('deepMergeJson', () => {
  it('overrides leaf primitives with generated values', () => {
    const existing = { name: 'old', version: '1.0.0' };
    const generated = { name: 'new', version: '2.0.0' };
    expect(deepMergeJson(existing, generated)).toEqual({ name: 'new', version: '2.0.0' });
  });

  it('preserves existing keys not in generated', () => {
    const existing = { name: 'my-sdk', version: '1.0.0', author: 'Alice', license: 'MIT' };
    const generated = { name: 'my-sdk', version: '2.0.0' };
    expect(deepMergeJson(existing, generated)).toEqual({
      name: 'my-sdk',
      version: '2.0.0',
      author: 'Alice',
      license: 'MIT',
    });
  });

  it('recursively merges nested objects', () => {
    const existing = {
      scripts: { test: 'vitest', build: 'tsup', custom: 'echo hi' },
    };
    const generated = {
      scripts: { test: 'vitest run', lint: 'eslint .' },
    };
    expect(deepMergeJson(existing, generated)).toEqual({
      scripts: { test: 'vitest run', build: 'tsup', custom: 'echo hi', lint: 'eslint .' },
    });
  });

  it('replaces arrays entirely with generated values', () => {
    const existing = { keywords: ['old', 'sdk'] };
    const generated = { keywords: ['new', 'api', 'sdk'] };
    expect(deepMergeJson(existing, generated)).toEqual({ keywords: ['new', 'api', 'sdk'] });
  });

  it('adds new keys from generated', () => {
    const existing = { name: 'my-sdk' };
    const generated = { name: 'my-sdk', description: 'A generated SDK' };
    expect(deepMergeJson(existing, generated)).toEqual({
      name: 'my-sdk',
      description: 'A generated SDK',
    });
  });

  it('returns generated when existing is a primitive', () => {
    expect(deepMergeJson('old', 'new')).toBe('new');
    expect(deepMergeJson(42, 99)).toBe(99);
  });

  it('returns generated when types differ (object vs array)', () => {
    expect(deepMergeJson({ a: 1 }, [1, 2, 3])).toEqual([1, 2, 3]);
    expect(deepMergeJson([1, 2], { a: 1 })).toEqual({ a: 1 });
  });

  it('handles null values', () => {
    expect(deepMergeJson({ a: 1 }, null)).toBe(null);
    expect(deepMergeJson(null, { a: 1 })).toEqual({ a: 1 });
  });
});
