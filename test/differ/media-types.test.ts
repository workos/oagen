import { describe, it, expect } from 'vitest';
import { mediaTypeParameters } from '../../src/differ/media-types.js';

describe('mediaTypeParameters', () => {
  it('leaves out charset, folds parameter names, unquotes values and sorts, so spellings compare equal', () => {
    expect(mediaTypeParameters('application/json')).toEqual([]);
    expect(mediaTypeParameters('application/json; charset=utf-8')).toEqual([]);
    expect(mediaTypeParameters('text/html; Charset=UTF-8')).toEqual([]);
    expect(mediaTypeParameters('application/pdf; version=1.7')).toEqual([['version', '1.7']]);
    expect(mediaTypeParameters('application/pdf; Version="1.7"')).toEqual([['version', '1.7']]);
    expect(mediaTypeParameters('application/pdf; version=1.7; profile=print')).toEqual(
      mediaTypeParameters('application/pdf; Profile="print" ;version=1.7'),
    );
    expect(mediaTypeParameters('text/plain; flowed')).toEqual([['flowed', '']]);
  });

  it('keeps a semicolon inside a quoted value as part of the value, so a changed profile is seen (Greptile round 4)', () => {
    const one = mediaTypeParameters('application/ld+json; profile="https://example.com/a;charset=one;z"');
    const two = mediaTypeParameters('application/ld+json; profile="https://example.com/a;charset=two;z"');
    expect(one).toEqual([['profile', 'https://example.com/a;charset=one;z']]);
    expect(two).toEqual([['profile', 'https://example.com/a;charset=two;z']]);
    expect(one).not.toEqual(two);
    // An escaped quote inside the value is decoded, not split on.
    expect(mediaTypeParameters('text/plain; title="a \\"b\\"; c"')).toEqual([['title', 'a "b"; c']]);
  });

  it('stays structured, so one parameter whose value holds a separator is not two parameters (Greptile round 5)', () => {
    expect(mediaTypeParameters('text/plain; title="report; version=2"')).toEqual([['title', 'report; version=2']]);
    expect(mediaTypeParameters('text/plain; title=report; version=2')).toEqual([
      ['title', 'report'],
      ['version', '2'],
    ]);
    expect(mediaTypeParameters('text/plain; title="report; version=2"')).not.toEqual(
      mediaTypeParameters('text/plain; title=report; version=2'),
    );
    // A value holding `=` is one value; a name is what comes before the first `=`.
    expect(mediaTypeParameters('text/plain; title="a=b"')).toEqual([['title', 'a=b']]);
    expect(mediaTypeParameters('text/plain; title=a=b')).toEqual([['title', 'a=b']]);
    expect(mediaTypeParameters('text/plain; title="a=b"')).not.toEqual(mediaTypeParameters('text/plain; title=a; b'));
  });

  it('tells a value apart by case, since whether case matters depends on the parameter', () => {
    expect(mediaTypeParameters('application/ld+json; profile="http://example.com/A"')).not.toEqual(
      mediaTypeParameters('application/ld+json; profile="http://example.com/a"'),
    );
  });
});
