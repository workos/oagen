import { describe, it, expect } from 'vitest';
import { singularize } from '../../src/utils/naming.js';

describe('singularize — -ses branch', () => {
  it('strips -es from words ending in -ses that are not in safe list', () => {
    // Line 124: word ends in "ses", not in safe list, length > 4
    expect(singularize('Databases')).toBe('Databas');
    expect(singularize('Diagnoses')).toBe('Diagnos');
  });
});
