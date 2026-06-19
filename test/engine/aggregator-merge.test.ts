import { describe, expect, it } from 'vitest';
import { addAggregatorEntries, aggregatorHasEntry } from '../../src/engine/aggregator-merge.js';

const PY_CLIENT = `from workos.sso import SSO
from workos.vault import Vault


class WorkOSClient:
    @property
    def sso(self) -> SSO:
        return SSO(self)

    @property
    def vault(self) -> Vault:
        return Vault(self)
`;

describe('aggregatorHasEntry', () => {
  it('detects a present entry', () => {
    expect(aggregatorHasEntry(PY_CLIENT, 'def vault')).toBe(true);
  });
  it('reports an absent entry', () => {
    expect(aggregatorHasEntry(PY_CLIENT, 'def directory_sync')).toBe(false);
  });
});

describe('addAggregatorEntries', () => {
  it('is a no-op when no insertions are given', () => {
    expect(addAggregatorEntries(PY_CLIENT, [])).toBe(PY_CLIENT);
  });

  it('is idempotent when the line already exists (trim-insensitive)', () => {
    const out = addAggregatorEntries(PY_CLIENT, [
      { line: 'from workos.vault import Vault', afterLineContaining: 'import' },
    ]);
    expect(out).toBe(PY_CLIENT);
  });

  it('inserts an import after the last existing import line', () => {
    const out = addAggregatorEntries(PY_CLIENT, [
      { line: 'from workos.directory_sync import DirectorySync', afterLineContaining: 'import ' },
    ]);
    const lines = out.split('\n');
    // Lands immediately after the last import (the Vault import), before the blank line.
    expect(lines[0]).toBe('from workos.sso import SSO');
    expect(lines[1]).toBe('from workos.vault import Vault');
    expect(lines[2]).toBe('from workos.directory_sync import DirectorySync');
    expect(lines[3]).toBe('');
  });

  it('never removes or reorders existing lines', () => {
    const before = PY_CLIENT.split('\n');
    const out = addAggregatorEntries(PY_CLIENT, [
      { line: 'from workos.directory_sync import DirectorySync', afterLineContaining: 'import ' },
    ]);
    const after = out.split('\n');
    // Every original line is still present, in its original relative order.
    let cursor = 0;
    for (const orig of before) {
      const found = after.indexOf(orig, cursor);
      expect(found).toBeGreaterThanOrEqual(cursor);
      cursor = found + 1;
    }
  });

  it('appends when the anchor is not matched', () => {
    const out = addAggregatorEntries('a\nb\n', [{ line: 'c', afterLineContaining: 'zzz' }]);
    expect(out).toBe('a\nb\nc\n');
  });

  it('prepends when the fallback position is prepend and the anchor is unmatched', () => {
    const out = addAggregatorEntries('a\nb\n', [{ line: 'c', position: 'prepend' }]);
    expect(out).toBe('c\na\nb\n');
  });

  it('preserves the absence of a trailing newline', () => {
    const out = addAggregatorEntries('a\nb', [{ line: 'c' }]);
    expect(out).toBe('a\nb\nc');
  });

  it('applies multiple insertions deterministically (import + accessor)', () => {
    const out = addAggregatorEntries(PY_CLIENT, [
      { line: 'from workos.directory_sync import DirectorySync', afterLineContaining: 'import ' },
      { line: '    @property', afterLineContaining: '        return Vault(self)' },
      { line: '    def directory_sync(self) -> DirectorySync:', afterLineContaining: '    @property' },
    ]);
    expect(aggregatorHasEntry(out, 'from workos.directory_sync import DirectorySync')).toBe(true);
    expect(aggregatorHasEntry(out, 'def directory_sync(self) -> DirectorySync:')).toBe(true);
    // The original Vault accessor is untouched.
    expect(aggregatorHasEntry(out, 'def vault(self) -> Vault:')).toBe(true);
  });
});
