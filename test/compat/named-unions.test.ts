import { describe, expect, it } from 'vitest';
import { specDerivedNames } from '../../src/compat/spec-filter.js';
import { nodeHints } from '../../src/compat/language-hints.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec } from '../../src/ir/types.js';

describe('specDerivedNames — named unions', () => {
  it('counts a type reached only as a named union variant as spec-derived', () => {
    const spec: ApiSpec = {
      name: 'Test',
      version: '1.0.0',
      baseUrl: '',
      services: [],
      enums: [],
      models: [
        {
          name: 'Pet',
          fields: [],
          variants: [
            { kind: 'model', name: 'Cat' },
            { kind: 'enum', name: 'Mood', values: ['happy'] },
          ],
          compositionKind: 'oneOf',
        },
      ],
      sdk: defaultSdkBehavior(),
    };

    const names = specDerivedNames(spec, nodeHints);
    expect(names.has('Pet')).toBe(true);
    // The variant and its language-derived names, as for a field type.
    expect(names.has('Cat')).toBe(true);
    expect(names.has('CatResponse')).toBe(true);
    expect(names.has('SerializedCat')).toBe(true);
    // An inline enum is filtered here exactly as one on a field is: only
    // top-level enums (in spec.enums) count.
    expect(names.has('Mood')).toBe(false);
  });
});
