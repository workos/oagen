import { describe, it, expect } from 'vitest';
import { registerExtractor, getExtractor } from '../../src/compat/extractor-registry.js';
import type { Extractor } from '../../src/compat/types.js';

describe('extractor registry', () => {
  it('throws with available languages when requesting unknown language', () => {
    const mock: Extractor = {
      language: 'extractor-test-lang',
      extract: async () => ({
        language: 'extractor-test-lang',
        extractedFrom: '/test',
        extractedAt: new Date().toISOString(),
        classes: {},
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      }),
    };
    registerExtractor(mock);

    expect(() => getExtractor('nonexistent')).toThrow(/No extractor registered for language: nonexistent/);
    expect(() => getExtractor('nonexistent')).toThrow(/extractor-test-lang/);
  });

  it('returns registered extractor by language', () => {
    const mock: Extractor = {
      language: 'extractor-roundtrip',
      extract: async () => ({
        language: 'extractor-roundtrip',
        extractedFrom: '/test',
        extractedAt: new Date().toISOString(),
        classes: {},
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      }),
    };
    registerExtractor(mock);
    expect(getExtractor('extractor-roundtrip')).toBe(mock);
  });
});
