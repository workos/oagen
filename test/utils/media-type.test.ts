import { describe, it, expect } from 'vitest';
import {
  isJsonMediaType,
  isPlainJsonMediaType,
  mediaTypeEssence,
  mediaTypeNameFragment,
  mediaTypeNamingOrder,
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
    // Beside another spelling of its essence, its `charset` tells it apart — by
    // being declared, not by its value (#389) — whatever the order.
    expect(mediaTypeNameFragment('APPLICATION/XML; charset=utf-8', siblings)).toBe('ApplicationXmlCharset');
    expect(mediaTypeNameFragment('APPLICATION/XML; charset=utf-8', [...siblings].reverse())).toBe(
      'ApplicationXmlCharset',
    );
    // The unparameterized spelling keeps the bare fragment either way.
    expect(mediaTypeNameFragment('application/xml', siblings)).toBe('ApplicationXml');
    // Parameters are lower-cased before casing; a `charset` beside another
    // parameter is left out, as `oagen diff` leaves it out (#389).
    expect(mediaTypeNameFragment('application/xml; Charset=UTF-8; q=1', ['application/xml'])).toBe('ApplicationXmlQ1');
    // The key itself among the siblings is not its own sibling.
    expect(mediaTypeNameFragment('application/xml; charset=utf-8', ['application/xml; charset=utf-8'])).toBe(
      'ApplicationXml',
    );
  });

  it('names a key by the parameters `oagen diff` compares: `charset` left out, the rest sorted (#389)', () => {
    // Beside a key told apart by another parameter, a `charset` adds nothing,
    // so the key keeps the name it had alone.
    const versioned = ['application/json', 'application/yaml; charset=utf-8', 'application/yaml; version=2'];
    expect(mediaTypeNameFragment('application/yaml; charset=utf-8', versioned)).toBe('ApplicationYaml');
    expect(mediaTypeNameFragment('application/yaml; version=2', versioned)).toBe('ApplicationYamlVersion2');
    // A `charset` beside another parameter is left out of the name.
    for (const key of ['application/yaml; version=2; charset=utf-8', 'application/yaml; Charset=UTF-16; version=2']) {
      expect(mediaTypeNameFragment(key, ['application/yaml', key]), key).toBe('ApplicationYamlVersion2');
    }
    // The parameters are sorted, so their order is not in the name.
    for (const key of ['application/yaml; a=1; b=2', 'application/yaml; b=2; A=1']) {
      expect(mediaTypeNameFragment(key, ['application/yaml', key]), key).toBe('ApplicationYamlA1B2');
    }
  });

  it('tells a key apart by declaring a `charset`, never by its value, only when nothing else does (#389)', () => {
    for (const key of ['application/yaml; charset=utf-8', 'Application/YAML; Charset=ISO-8859-1']) {
      expect(mediaTypeNameFragment(key, ['application/yaml', key]), key).toBe('ApplicationYamlCharset');
      expect(mediaTypeNameFragment(key, [key, 'application/yaml']), key).toBe('ApplicationYamlCharset');
      expect(mediaTypeNameFragment('application/yaml', ['application/yaml', key]), key).toBe('ApplicationYaml');
    }
    const versioned = ['application/yaml; version=2', 'application/yaml; version=2; charset=utf-8'];
    expect(mediaTypeNameFragment(versioned[1], versioned)).toBe('ApplicationYamlVersion2Charset');
    expect(mediaTypeNameFragment(versioned[0], versioned)).toBe('ApplicationYamlVersion2');
  });
});

describe('mediaTypeNamingOrder', () => {
  it('keeps the document order of keys that derive names of their own', () => {
    const keys = ['text/html', 'application/json', 'application/yaml; version=2', 'application/yaml; charset=utf-8'];
    expect(mediaTypeNamingOrder(keys)).toEqual(keys);
    expect(mediaTypeNamingOrder([...keys].reverse())).toEqual([...keys].reverse());
  });

  it('takes keys that derive one fragment in one order whatever the document order: case folded, lower case first (#389)', () => {
    const keys = ['APPLICATION/XML', 'text/csv', 'application/xml', 'Application/XML'];
    // Each keeps the place of a key of its fragment; the keys that share one
    // take those places by spelling.
    expect(mediaTypeNamingOrder(keys)).toEqual(['application/xml', 'text/csv', 'Application/XML', 'APPLICATION/XML']);
    expect(mediaTypeNamingOrder([...keys].reverse())).toEqual([
      'application/xml',
      'Application/XML',
      'text/csv',
      'APPLICATION/XML',
    ]);
    // Two keys that differ only in their charset's value, or in the order of
    // their parameters, are taken by spelling too.
    const charsets = ['application/yaml; charset=utf-8', 'application/yaml; charset=utf-16'];
    expect(mediaTypeNamingOrder(charsets)).toEqual([charsets[1], charsets[0]]);
    expect(mediaTypeNamingOrder([...charsets].reverse())).toEqual([charsets[1], charsets[0]]);
    const reordered = ['application/yaml; b=2; a=1', 'application/yaml; a=1; b=2'];
    expect(mediaTypeNamingOrder(reordered)).toEqual([reordered[1], reordered[0]]);
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
