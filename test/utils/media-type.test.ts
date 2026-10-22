import { describe, it, expect } from 'vitest';
import { mediaTypeEssence } from '../../src/utils/media-type.js';

describe('mediaTypeEssence', () => {
  it('strips parameters', () => {
    expect(mediaTypeEssence('application/json; charset=utf-8')).toBe('application/json');
    expect(mediaTypeEssence('multipart/form-data; boundary=x')).toBe('multipart/form-data');
    expect(mediaTypeEssence('application/pdf;version=1.7;q=0.9')).toBe('application/pdf');
  });

  it('folds case', () => {
    expect(mediaTypeEssence('APPLICATION/JSON')).toBe('application/json');
    expect(mediaTypeEssence('Application/Vnd.Api+JSON')).toBe('application/vnd.api+json');
  });

  it('trims whitespace around the type', () => {
    expect(mediaTypeEssence(' application/json ; charset=utf-8')).toBe('application/json');
    expect(mediaTypeEssence('\ttext/plain\t')).toBe('text/plain');
  });

  it('keeps a structured-syntax suffix and a wildcard as written', () => {
    expect(mediaTypeEssence('application/merge-patch+json')).toBe('application/merge-patch+json');
    expect(mediaTypeEssence('*/*')).toBe('*/*');
    expect(mediaTypeEssence('application/*; q=0.5')).toBe('application/*');
  });

  it('reads an empty or parameter-only key as an empty essence', () => {
    expect(mediaTypeEssence('')).toBe('');
    expect(mediaTypeEssence('; charset=utf-8')).toBe('');
  });
});
