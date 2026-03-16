import { describe, it, expect } from 'vitest';
import { applyConfig } from '../../src/cli/plugin-loader.js';
import { getExtractor } from '../../src/compat/extractor-registry.js';
import type { Extractor } from '../../src/compat/types.js';

describe('applyConfig — extractors', () => {
  it('registers extractors from config', () => {
    const mockExtractor: Extractor = {
      language: 'plugin-test-lang',
      extract: async () => ({
        language: 'plugin-test-lang',
        extractedFrom: '/test',
        extractedAt: new Date().toISOString(),
        classes: {},
        interfaces: {},
        typeAliases: {},
        enums: {},
        exports: {},
      }),
    };

    applyConfig({ extractors: [mockExtractor] });

    const retrieved = getExtractor('plugin-test-lang');
    expect(retrieved.language).toBe('plugin-test-lang');
  });
});
