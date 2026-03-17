import { describe, it, expect, vi } from 'vitest';
import { registerEmitter, getEmitter } from '../../src/engine/registry.js';
import type { Emitter } from '../../src/engine/types.js';
import { IR_VERSION } from '../../src/ir/types.js';

describe('emitter registry', () => {
  it('throws with available languages when requesting unknown language', () => {
    // Register a known emitter first
    const mock: Emitter = {
      language: 'registry-test-lang',
      contractVersion: IR_VERSION,
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
      contractVersion: IR_VERSION,
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

  it('registers successfully when contractVersion matches IR_VERSION', () => {
    const mock: Emitter = {
      language: 'registry-contract-match',
      contractVersion: IR_VERSION,
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
    expect(getEmitter('registry-contract-match')).toBe(mock);
  });

  it('throws RegistryError when contractVersion does not match IR_VERSION', () => {
    const mock: Emitter = {
      language: 'registry-contract-mismatch',
      contractVersion: IR_VERSION + 999,
      generateModels: () => [],
      generateEnums: () => [],
      generateResources: () => [],
      generateClient: () => [],
      generateErrors: () => [],
      generateConfig: () => [],
      generateTests: () => [],
      fileHeader: () => '',
    };
    expect(() => registerEmitter(mock)).toThrow(/contractVersion/);
  });

  it('emits console.warn but still registers when contractVersion is missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const mock: Emitter = {
        language: 'registry-contract-missing',
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
      expect(warnSpy).toHaveBeenCalledWith(
        'Warning: Emitter "registry-contract-missing" does not declare a contractVersion.',
      );
      expect(getEmitter('registry-contract-missing')).toBe(mock);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
