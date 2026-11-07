import { describe, it, expect } from 'vitest';
import { singularize } from '../../src/utils/naming.js';

describe('singularize — -ses branch', () => {
  it('strips -es from words ending in -ses that are not in safe list', () => {
    // A `-ses` word loses only its `s` unless the stem is sibilant (#620):
    // `Databases` is `Database`, `Diagnoses` is `Diagnose` (the `-is` noun's
    // plural read as a plain `s`, a documented limit of the suffix rules),
    // where `Statuses` and `Addresses` drop the `es`.
    expect(singularize('Databases')).toBe('Database');
    expect(singularize('Diagnoses')).toBe('Diagnose');
    expect(singularize('Statuses')).toBe('Status');
    expect(singularize('Addresses')).toBe('Address');
  });
});
