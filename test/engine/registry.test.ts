import { describe, it, expect } from 'vitest';
import { registerEmitter, getEmitter } from '../../src/engine/registry.js';
import type { Emitter } from '../../src/engine/types.js';

describe('emitter registry', () => {
  it('throws with available languages when requesting unknown language', () => {
    // Register a known emitter first
    const mock: Emitter = {
      language: 'registry-test-lang',
      generateModels: () => [],
      generateEnums: () => [],
      generateResources: () => [],
      generateClient: () => [],
      generateErrors: () => [],
      generateConfig: () => [],
      generateTypeSignatures: () => [],
      generateTests: () => [],
      fileHeader: () => '',
    };
    registerEmitter(mock);

    expect(() => getEmitter('nonexistent-lang')).toThrow(/Unknown language: nonexistent-lang/);
    expect(() => getEmitter('nonexistent-lang')).toThrow(/registry-test-lang/);
  });

  it('returns registered emitter by language', () => {
    const mock: Emitter = {
      language: 'registry-roundtrip',
      generateModels: () => [],
      generateEnums: () => [],
      generateResources: () => [],
      generateClient: () => [],
      generateErrors: () => [],
      generateConfig: () => [],
      generateTypeSignatures: () => [],
      generateTests: () => [],
      fileHeader: () => '',
    };
    registerEmitter(mock);
    expect(getEmitter('registry-roundtrip')).toBe(mock);
  });

  it('registers emitter without version checks', () => {
    const mock: Emitter = {
      language: 'registry-no-version',
      generateModels: () => [],
      generateEnums: () => [],
      generateResources: () => [],
      generateClient: () => [],
      generateErrors: () => [],
      generateConfig: () => [],
      generateTests: () => [],
      fileHeader: () => '',
    };
    registerEmitter(mock);
    expect(getEmitter('registry-no-version')).toBe(mock);
  });
});
