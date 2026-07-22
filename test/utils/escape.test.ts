import { describe, it, expect } from 'vitest';
import { escapeBlockComment } from '../../src/utils/escape.js';

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
