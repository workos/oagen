import { describe, it, expect } from 'vitest';
import { mediaTypeEssence, mediaTypeNameFragment } from '../../src/utils/media-type.js';

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

describe('mediaTypeNameFragment', () => {
  it('PascalCases the essence', () => {
    expect(mediaTypeNameFragment('text/html')).toBe('TextHtml');
    expect(mediaTypeNameFragment('text/csv')).toBe('TextCsv');
    expect(mediaTypeNameFragment('application/vnd.api+json')).toBe('ApplicationVndApiJson');
  });

  it('names every spelling of one media type the same', () => {
    for (const spelling of [
      'application/json',
      'application/json; charset=utf-8',
      'APPLICATION/JSON',
      ' application/json ',
    ]) {
      expect(mediaTypeNameFragment(spelling), spelling).toBe('ApplicationJson');
    }
    expect(mediaTypeNameFragment('multipart/form-data; boundary=x')).toBe('MultipartFormData');
  });

  it('reads a wildcard segment as Any and an empty essence as Content', () => {
    expect(mediaTypeNameFragment('application/*')).toBe('ApplicationAny');
    expect(mediaTypeNameFragment('*/*')).toBe('AnyAny');
    expect(mediaTypeNameFragment('')).toBe('Content');
    expect(mediaTypeNameFragment('; charset=utf-8')).toBe('Content');
  });
});
