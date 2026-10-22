import { describe, it, expect } from 'vitest';
import { mediaTypeEssence, mediaTypeNameFragment, parseMediaType } from '../../src/utils/media-type.js';

describe('parseMediaType (RFC 9110 §8.3.1)', () => {
  it('reads the essence and each parameter, names lower-cased, token values as written', () => {
    expect(parseMediaType('Application/PDF; Version=1.7; q=0.9')).toEqual({
      essence: 'application/pdf',
      parameters: [
        { name: 'version', value: '1.7' },
        { name: 'q', value: '0.9' },
      ],
    });
    expect(parseMediaType('text/plain')).toEqual({ essence: 'text/plain', parameters: [] });
  });

  it('does not split at a semicolon inside a quoted value, and drops the quotes (Greptile round 4)', () => {
    expect(parseMediaType('application/ld+json; profile="https://example.com/a;charset=one;z"')).toEqual({
      essence: 'application/ld+json',
      parameters: [{ name: 'profile', value: 'https://example.com/a;charset=one;z' }],
    });
    // The essence is read before any parameter, so a quoted `;` never truncates it.
    expect(mediaTypeEssence('application/ld+json; profile="x;y"; charset=utf-8')).toBe('application/ld+json');
    expect(parseMediaType('text/plain; a="x;y"; b=z').parameters).toEqual([
      { name: 'a', value: 'x;y' },
      { name: 'b', value: 'z' },
    ]);
  });

  it('decodes a backslash escape inside a quoted value', () => {
    expect(parseMediaType('text/plain; title="say \\"hi\\"; ok"').parameters).toEqual([
      { name: 'title', value: 'say "hi"; ok' },
    ]);
    expect(parseMediaType('text/plain; path="c:\\\\dir"').parameters).toEqual([{ name: 'path', value: 'c:\\dir' }]);
  });

  it('reads a bare parameter as one with the empty value, and skips an empty segment', () => {
    expect(parseMediaType('text/plain; flowed; ; charset=utf-8').parameters).toEqual([
      { name: 'flowed', value: '' },
      { name: 'charset', value: 'utf-8' },
    ]);
    expect(parseMediaType('text/plain;').parameters).toEqual([]);
  });

  it('trims whitespace around the essence, a name and a value, and lets an unclosed quote run to the end', () => {
    expect(parseMediaType(' text/html ; charset = utf-8 ')).toEqual({
      essence: 'text/html',
      parameters: [{ name: 'charset', value: 'utf-8' }],
    });
    expect(parseMediaType('text/plain; q="abc').parameters).toEqual([{ name: 'q', value: 'abc' }]);
    expect(parseMediaType('')).toEqual({ essence: '', parameters: [] });
    expect(parseMediaType('; charset=utf-8').essence).toBe('');
  });
});

describe('mediaTypeNameFragment reads parameters through parseMediaType', () => {
  it('keeps a quoted value with a semicolon whole, beside a sibling of the same essence', () => {
    const siblings = ['application/ld+json', 'application/ld+json; profile="https://example.com/a;b"'];
    expect(mediaTypeNameFragment(siblings[1], siblings)).toBe('ApplicationLdJsonProfileHttpsExampleComAB');
    expect(mediaTypeNameFragment(siblings[0], siblings)).toBe('ApplicationLdJson');
    // Alone, the parameter does not reach the name at all.
    expect(mediaTypeNameFragment(siblings[1])).toBe('ApplicationLdJson');
  });

  it('names a bare parameter and a quoted token like their unquoted spellings', () => {
    const siblings = ['text/plain', 'text/plain; format="flowed"', 'text/plain; delsp'];
    expect(mediaTypeNameFragment('text/plain; format="flowed"', siblings)).toBe('TextPlainFormatFlowed');
    expect(mediaTypeNameFragment('text/plain; format=flowed', siblings)).toBe('TextPlainFormatFlowed');
    expect(mediaTypeNameFragment('text/plain; delsp', siblings)).toBe('TextPlainDelsp');
  });
});
