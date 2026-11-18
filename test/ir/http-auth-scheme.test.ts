import { describe, expect, it } from 'vitest';
import { foldHttpAuthScheme, isHttpAuthScheme } from '../../src/ir/http-auth-scheme.js';
import { foldHttpAuthScheme as exported } from '../../src/index.js';

/**
 * Covers `src/ir/http-auth-scheme.ts` in isolation (#662): the one rule that
 * says whether two HTTP authentication scheme names are the same scheme
 * (case-insensitive, RFC 9110 §11.1), and what can be a scheme name at all
 * (an RFC 9110 token). The parser's reading of `components.securitySchemes`
 * on it is covered in test/parser/auth-scheme-kinds.test.ts, the differ's
 * comparison on it in test/differ/auth-scheme-kinds.test.ts.
 */
describe('foldHttpAuthScheme', () => {
  it('lower-cases a scheme name, so every spelling of one scheme folds to one string', () => {
    expect(foldHttpAuthScheme('Digest')).toBe('digest');
    expect(foldHttpAuthScheme('digest')).toBe('digest');
    expect(foldHttpAuthScheme('DIGEST')).toBe('digest');
    expect(foldHttpAuthScheme('Bearer')).toBe('bearer');
    expect(foldHttpAuthScheme('SCRAM-SHA-256')).toBe('scram-sha-256');
    expect(foldHttpAuthScheme('PrivateToken')).toBe('privatetoken');
  });

  it('keeps two schemes apart', () => {
    expect(foldHttpAuthScheme('Digest')).not.toBe(foldHttpAuthScheme('HOBA'));
    expect(foldHttpAuthScheme('SCRAM-SHA-1')).not.toBe(foldHttpAuthScheme('SCRAM-SHA-256'));
  });

  it('is exported from the package, for an emitter comparing an http scheme’s name', () => {
    expect(exported).toBe(foldHttpAuthScheme);
  });
});

describe('isHttpAuthScheme', () => {
  it.each([
    'basic',
    'Bearer',
    'Digest',
    'HOBA',
    'Mutual',
    'Negotiate',
    'OAuth',
    'SCRAM-SHA-1',
    'SCRAM-SHA-256',
    'vapid',
    'DPoP',
    'GNAP',
    'PrivateToken',
    'AWS4-HMAC-SHA256',
    // Every `tchar` RFC 9110 §5.6.2 lists beside the letters and digits.
    "!#$%&'*+-.^_`|~",
    '0',
  ])('accepts the token %s', (scheme) => {
    expect(isHttpAuthScheme(scheme)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a blank string', '  '],
    ['a padded name', ' Bearer '],
    ['a trailing space', 'Bearer '],
    ['two words', 'my scheme'],
    ['a tab', 'Dig\test'],
    ['a line break', 'Digest\r\nX-Injected: 1'],
    ['a trailing line break', 'Digest\n'],
    ['a slash', 'a/b'],
    ['a quoted name', '"Digest"'],
    ['a parameter', 'Digest;q=1'],
    ['a comma', 'Basic,Bearer'],
    ['a colon', 'Digest:'],
    ['a non-ASCII letter', 'Dïgest'],
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['an array', ['Digest']],
    ['an object', { scheme: 'Digest' }],
  ])('refuses %s', (_label, value) => {
    expect(isHttpAuthScheme(value)).toBe(false);
  });
});
