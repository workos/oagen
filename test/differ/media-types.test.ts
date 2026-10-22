import { describe, it, expect } from 'vitest';
import { mediaTypeParameters } from '../../src/differ/media-types.js';

describe('mediaTypeParameters', () => {
  it('leaves out charset, folds parameter names, unquotes values and sorts, so spellings compare equal', () => {
    expect(mediaTypeParameters('application/json')).toBe('');
    expect(mediaTypeParameters('application/json; charset=utf-8')).toBe('');
    expect(mediaTypeParameters('text/html; Charset=UTF-8')).toBe('');
    expect(mediaTypeParameters('application/pdf; version=1.7')).toBe('version=1.7');
    expect(mediaTypeParameters('application/pdf; Version="1.7"')).toBe('version=1.7');
    expect(mediaTypeParameters('application/pdf; version=1.7; profile=print')).toBe(
      mediaTypeParameters('application/pdf; Profile="print" ;version=1.7'),
    );
    expect(mediaTypeParameters('text/plain; flowed')).toBe('flowed');
  });

  it('keeps a semicolon inside a quoted value as part of the value, so a changed profile is seen (Greptile round 4)', () => {
    const one = mediaTypeParameters('application/ld+json; profile="https://example.com/a;charset=one;z"');
    const two = mediaTypeParameters('application/ld+json; profile="https://example.com/a;charset=two;z"');
    expect(one).toBe('profile=https://example.com/a;charset=one;z');
    expect(two).toBe('profile=https://example.com/a;charset=two;z');
    expect(one).not.toBe(two);
    // An escaped quote inside the value is decoded, not split on.
    expect(mediaTypeParameters('text/plain; title="a \\"b\\"; c"')).toBe('title=a "b"; c');
  });

  it('tells a value apart by case, since whether case matters depends on the parameter', () => {
    expect(mediaTypeParameters('application/ld+json; profile="http://example.com/A"')).not.toBe(
      mediaTypeParameters('application/ld+json; profile="http://example.com/a"'),
    );
  });
});
