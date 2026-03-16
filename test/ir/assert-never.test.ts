import { describe, it, expect } from 'vitest';
import { assertNever } from '../../src/ir/types.js';

describe('assertNever', () => {
  it('throws with the unexpected kind in the message', () => {
    const bogus = { kind: 'bogus' } as never;
    expect(() => assertNever(bogus)).toThrow('Unexpected TypeRef kind: bogus');
  });
});
