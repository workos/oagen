import { describe, it, expect } from 'vitest';
import { COMPAT_SCHEMA_VERSION, isCompatibleSchemaVersion, validateSnapshot } from '../../src/compat/schema.js';
import { getDefaultPolicy } from '../../src/compat/policy.js';

describe('COMPAT_SCHEMA_VERSION', () => {
  it('is version 1', () => {
    expect(COMPAT_SCHEMA_VERSION).toBe('1');
  });
});

describe('isCompatibleSchemaVersion', () => {
  it('returns true for matching version', () => {
    expect(isCompatibleSchemaVersion({ schemaVersion: '1' })).toBe(true);
  });

  it('returns false for different version', () => {
    expect(isCompatibleSchemaVersion({ schemaVersion: '2' })).toBe(false);
  });

  it('returns false for missing version', () => {
    expect(isCompatibleSchemaVersion({})).toBe(false);
  });
});

describe('validateSnapshot', () => {
  it('accepts a valid snapshot', () => {
    expect(
      validateSnapshot({
        schemaVersion: '1',
        language: 'php',
        sdkName: 'workos-php',
        source: { extractedAt: '2026-04-22T00:00:00.000Z' },
        extractor: { name: 'php-extractor' },
        policies: getDefaultPolicy('php'),
        symbols: [],
      }),
    ).toBe(true);
  });

  it('rejects null', () => {
    expect(validateSnapshot(null)).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(validateSnapshot('string')).toBe(false);
    expect(validateSnapshot(42)).toBe(false);
  });

  it('rejects missing required fields', () => {
    expect(validateSnapshot({ schemaVersion: '1' })).toBe(false);
    expect(validateSnapshot({ schemaVersion: '1', language: 'php' })).toBe(false);
  });

  it('rejects when symbols is not an array', () => {
    expect(
      validateSnapshot({
        schemaVersion: '1',
        language: 'php',
        sdkName: 'test',
        source: { extractedAt: '' },
        extractor: { name: 'test' },
        policies: {},
        symbols: 'not-array',
      }),
    ).toBe(false);
  });
});
