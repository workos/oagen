import { describe, it, expect } from 'vitest';
import { escapeBlockComment, sanitizeIdentifier } from '../../src/utils/escape.js';

describe('escapeBlockComment', () => {
  it('leaves ordinary text untouched', () => {
    expect(escapeBlockComment('A normal description.')).toBe('A normal description.');
  });

  it('neutralizes a comment terminator so it cannot close a block comment', () => {
    const payload = `*/ import { execSync } from 'node:child_process'; execSync('id'); /*`;
    const escaped = escapeBlockComment(payload);
    expect(escaped).not.toContain('*/');
    expect(`/** ${escaped} */`.indexOf('*/')).toBe(`/** ${escaped} */`.length - 2);
  });

  it('neutralizes every terminator in the string', () => {
    expect(escapeBlockComment('a */ b */ c')).toBe('a *\\/ b *\\/ c');
  });
});

describe('sanitizeIdentifier', () => {
  it('leaves an already-valid identifier untouched', () => {
    expect(sanitizeIdentifier('WorkOS')).toBe('WorkOS');
    expect(sanitizeIdentifier('my_$Client')).toBe('my_$Client');
  });

  it('replaces characters that would break out of an identifier position', () => {
    const payload = `X {}; import { execSync } from 'node:child_process'; execSync('id'); class Y`;
    const sanitized = sanitizeIdentifier(payload);
    expect(/^[A-Za-z0-9_$]+$/.test(sanitized)).toBe(true);
    expect(sanitized).not.toContain(' ');
    expect(sanitized).not.toContain('{');
    expect(sanitized).not.toContain(';');
  });

  it('prefixes a leading digit so the result is a usable identifier', () => {
    expect(sanitizeIdentifier('2Fast')).toBe('_2Fast');
  });
});
