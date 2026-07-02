import { describe, expect, it } from 'vitest';
import { mergeScopedManifestRecords, type Manifest } from '../../src/engine/manifest.js';

function manifest(files: string[], operations?: Record<string, unknown>): Manifest {
  return {
    version: 2,
    language: 'mock',
    files,
    ...(operations ? { operations } : {}),
  };
}

describe('mergeScopedManifestRecords', () => {
  it('unions prior and scoped file paths, preserving unselected records', () => {
    const prev = manifest(['sso/client.rb', 'vault/vault.rb']);
    const merged = mergeScopedManifestRecords(prev, ['vault/vault.rb', 'vault/secret.rb']);
    // sso/client.rb (unselected) survives; vault gains secret.rb; sorted + deduped.
    expect(merged.files).toEqual(['sso/client.rb', 'vault/secret.rb', 'vault/vault.rb']);
  });

  it('shallow-merges operations with scoped entries overriding prior ones', () => {
    const prev = manifest(['sso/client.rb', 'vault/vault.rb'], {
      'GET /sso': { service: 'sso' },
      'GET /vault': { service: 'vault', sdkMethod: 'old' },
    });
    const merged = mergeScopedManifestRecords(prev, ['vault/vault.rb'], {
      'GET /vault': { service: 'vault', sdkMethod: 'new' },
      'POST /vault': { service: 'vault', sdkMethod: 'create' },
    });
    expect(merged.operations).toEqual({
      'GET /sso': { service: 'sso' }, // unselected operation preserved
      'GET /vault': { service: 'vault', sdkMethod: 'new' }, // scoped overrides prior
      'POST /vault': { service: 'vault', sdkMethod: 'create' }, // new scoped op added
    });
  });

  it('returns the scoped subset unchanged when there is no prior manifest (first run)', () => {
    const merged = mergeScopedManifestRecords(null, ['vault/vault.rb'], { 'GET /vault': { service: 'vault' } });
    expect(merged.files).toEqual(['vault/vault.rb']);
    expect(merged.operations).toEqual({ 'GET /vault': { service: 'vault' } });
  });

  it('carries prior operations through when the scoped run has none', () => {
    const prev = manifest(['sso/client.rb'], { 'GET /sso': { service: 'sso' } });
    const merged = mergeScopedManifestRecords(prev, ['vault/vault.rb']);
    expect(merged.operations).toEqual({ 'GET /sso': { service: 'sso' } });
  });

  it('leaves operations undefined when neither side has any', () => {
    const prev = manifest(['sso/client.rb']);
    const merged = mergeScopedManifestRecords(prev, ['vault/vault.rb']);
    expect(merged.operations).toBeUndefined();
  });

  it('does not duplicate a file present in both prior and scoped sets', () => {
    const prev = manifest(['shared/models.rb', 'vault/vault.rb']);
    const merged = mergeScopedManifestRecords(prev, ['shared/models.rb', 'vault/vault.rb']);
    expect(merged.files).toEqual(['shared/models.rb', 'vault/vault.rb']);
  });
});
