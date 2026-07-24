import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { elixirExtractor } from '../../../src/compat/extractors/elixir.js';

/**
 * Generated-style Elixir enums expose members via `values/0` + `cast/dump`
 * clauses instead of the hand-written `def name, do: "value"` style. The
 * extractor must classify these modules as enums (not classes) and recover
 * the wire value for each atom from the `dump/1` clauses.
 */
const fixturePath = resolve(import.meta.dirname, '../../fixtures/sample-sdk-elixir-generated');

describe('elixirExtractor — generated-style enums', () => {
  it('reads members from a multiline values/0 list with dump/1 wire values', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.enums.VerificationStrategy).toBeDefined();
    expect(surface.enums.VerificationStrategy.members).toEqual({
      dns: 'dns',
      manual: 'manual',
    });
  });

  it('recovers exact wire values when atom names differ from wire strings', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.enums.GrantType.members).toEqual({
      urn_grant: 'urn:ietf:params:oauth:grant-type:token-exchange',
      password: 'password',
    });
  });

  it('reads numeric enums from the values/0 literal list', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.enums.Priority.members).toEqual({
      '1': '1',
      '2': '2',
    });
  });

  it('classifies generated enum modules as enums, not classes', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.classes.VerificationStrategy).toBeUndefined();
    expect(surface.classes.GrantType).toBeUndefined();
    expect(surface.classes.Priority).toBeUndefined();
  });

  it('reads the full values/0 list when quoted atoms contain `]`', async () => {
    // The list-body match must skip over quoted segments — a `]` inside a
    // quoted atom must not terminate the list and drop later members.
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.enums.Scope.members['scope:[read]']).toBe('scope:[read]');
    expect(surface.enums.Scope.members.plain).toBe('plain');
  });

  it('maps named escapes in quoted atoms to their real characters', async () => {
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.enums.Scope.members['tab\tseparated']).toBe('tab\tseparated');
  });

  it('ignores dump/1 clauses for atoms absent from values/0', async () => {
    // Legacy dump clauses for deprecated values must not leak into the
    // extracted member set.
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.enums.Scope.members.legacy_removed).toBeUndefined();
    expect(Object.keys(surface.enums.Scope.members).sort()).toEqual(['plain', 'scope:[read]', 'tab\tseparated']);
  });

  it('extracts resource modules whose paths use string interpolation', async () => {
    // `#{URI.encode(...)}` must not be stripped as a comment — doing so leaves
    // an unterminated string and the whole module silently disappears.
    const surface = await elixirExtractor.extract(fixturePath);
    expect(surface.classes.Organizations).toBeDefined();
    expect(Object.keys(surface.classes.Organizations.methods).sort()).toEqual([
      'get_organization',
      'list_organizations',
    ]);
  });
});
