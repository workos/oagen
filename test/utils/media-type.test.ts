import { describe, it, expect } from 'vitest';
import {
  isJsonMediaType,
  isPlainJsonMediaType,
  mediaTypeEssence,
  mediaTypeNameFragment,
} from '../../src/utils/media-type.js';

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

  it('keeps a key’s parameters only when another spelling of its essence sits beside it', () => {
    const siblings = ['application/json', 'application/xml', 'APPLICATION/XML; charset=utf-8'];
    // Alone among its siblings, a parameterized key keeps the bare fragment.
    expect(mediaTypeNameFragment('application/yaml; charset=utf-8', siblings)).toBe('ApplicationYaml');
    // Beside another spelling of its essence, its parameters tell it apart, whatever the order.
    expect(mediaTypeNameFragment('APPLICATION/XML; charset=utf-8', siblings)).toBe('ApplicationXmlCharsetUtf8');
    expect(mediaTypeNameFragment('APPLICATION/XML; charset=utf-8', [...siblings].reverse())).toBe(
      'ApplicationXmlCharsetUtf8',
    );
    // The unparameterized spelling keeps the bare fragment either way.
    expect(mediaTypeNameFragment('application/xml', siblings)).toBe('ApplicationXml');
    // Parameters are lower-cased before casing, in the order written.
    expect(mediaTypeNameFragment('application/xml; Charset=UTF-8; q=1', ['application/xml'])).toBe(
      'ApplicationXmlCharsetUtf8Q1',
    );
    // The key itself among the siblings is not its own sibling.
    expect(mediaTypeNameFragment('application/xml; charset=utf-8', ['application/xml; charset=utf-8'])).toBe(
      'ApplicationXml',
    );
  });
});

describe('isPlainJsonMediaType and isJsonMediaType', () => {
  it('read application/json by essence, parameters and case aside', () => {
    for (const spelling of [
      'application/json',
      'application/json; charset=utf-8',
      'APPLICATION/JSON',
      ' application/json ',
    ]) {
      expect(isPlainJsonMediaType(spelling), spelling).toBe(true);
      expect(isJsonMediaType(spelling), spelling).toBe(true);
    }
  });

  it('read a +json structured-syntax suffix as JSON, but not as plain application/json', () => {
    for (const spelling of [
      'application/vnd.api+json',
      'application/merge-patch+json; charset=utf-8',
      'application/problem+json',
      'Application/Cloudevents+JSON',
    ]) {
      expect(isJsonMediaType(spelling), spelling).toBe(true);
      expect(isPlainJsonMediaType(spelling), spelling).toBe(false);
    }
  });

  it('read nothing else as JSON', () => {
    for (const spelling of ['text/json', 'application/jsonl', 'application/x-ndjson', 'application/xml', 'json', '']) {
      expect(isJsonMediaType(spelling), spelling).toBe(false);
      expect(isPlainJsonMediaType(spelling), spelling).toBe(false);
    }
  });
});
