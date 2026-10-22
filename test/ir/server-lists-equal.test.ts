import { describe, it, expect } from 'vitest';
import { normalizeServerUrl, serverListsEqual } from '../../src/ir/server-url.js';
import type { ServerEntry } from '../../src/ir/types.js';

/** Structural equality of server lists, as the parser and the differ use it (issue #251). */
describe('serverListsEqual', () => {
  const regional: ServerEntry = {
    url: 'https://{region}.api.example.com',
    description: 'Regional',
    variables: { region: { default: 'eu', enum: ['eu', 'us'], description: 'The region.' } },
  };

  it('is true for two lists built the same way', () => {
    expect(serverListsEqual([], [])).toBe(true);
    expect(serverListsEqual([regional], [structuredClone(regional)])).toBe(true);
  });

  it('treats an absent key and an undefined one alike', () => {
    expect(serverListsEqual([{ url: '/v1' }], [{ url: '/v1', description: undefined }])).toBe(true);
    expect(serverListsEqual([{ url: '/v1' }], [{ url: '/v1', variables: undefined }])).toBe(true);
    expect(
      serverListsEqual(
        [{ url: '/{v}', variables: { v: { default: '1' } } }],
        [{ url: '/{v}', variables: { v: { default: '1', enum: undefined, description: undefined } } }],
      ),
    ).toBe(true);
  });

  it('is false on a different length or order', () => {
    const plain: ServerEntry = { url: 'https://api.example.com' };
    expect(serverListsEqual([plain], [plain, regional])).toBe(false);
    expect(serverListsEqual([plain, regional], [regional, plain])).toBe(false);
  });

  it('is false on a different url or description', () => {
    expect(serverListsEqual([{ url: '/v1' }], [{ url: '/v2' }])).toBe(false);
    expect(serverListsEqual([{ url: '/v1', description: 'a' }], [{ url: '/v1', description: 'b' }])).toBe(false);
    expect(serverListsEqual([{ url: '/v1', description: 'a' }], [{ url: '/v1' }])).toBe(false);
  });

  it('compares urls through normalizeServerUrl (issue #293)', () => {
    const api: ServerEntry = { url: 'https://api.example.com' };
    expect(serverListsEqual([api], [{ url: 'https://API.example.com' }])).toBe(true);
    expect(serverListsEqual([api], [{ url: 'HTTPS://api.example.com' }])).toBe(true);
    expect(serverListsEqual([api], [{ url: 'https://api.example.com:443' }])).toBe(true);
    expect(serverListsEqual([api], [{ url: 'https://api.example.com/' }])).toBe(true);
    // The path is case-sensitive, and a template is not what it resolves to.
    expect(serverListsEqual([{ url: 'https://api.example.com/v1' }], [{ url: 'https://api.example.com/V1' }])).toBe(
      false,
    );
    expect(serverListsEqual([regional], [{ ...regional, url: 'https://{Region}.api.example.com' }])).toBe(false);
    // An authority ending in a placeholder may supply the path itself, so a
    // trailing `/` after it is a difference (Greptile): `/v1` vs `/v1/`.
    const basePath = { basePath: { default: '/v1' } };
    expect(
      serverListsEqual(
        [{ url: 'https://api.example.com{basePath}', variables: basePath }],
        [{ url: 'https://api.example.com{basePath}/', variables: basePath }],
      ),
    ).toBe(false);
    // A bare authority, and one under a placeholder scheme, with and without `/`.
    expect(serverListsEqual([api], [{ url: 'https://api.example.com/' }])).toBe(true);
    expect(serverListsEqual([{ url: '{s}://api.example.com' }], [{ url: '{s}://api.example.com/' }])).toBe(true);
    // After a placeholder the authority is kept as written, so a port or `/`
    // that a placeholder value could turn into path text is a difference
    // (Greptile): `host` = `api.example.com/v1` gives `/v1:443/v2` vs `/v1/v2`.
    const host = { host: { default: 'api.example.com/v1' } };
    expect(normalizeServerUrl('https://{host}:443/v2')).not.toBe(normalizeServerUrl('https://{host}/v2'));
    expect(
      serverListsEqual(
        [{ url: 'https://{host}:443/v2', variables: host }],
        [{ url: 'https://{host}/v2', variables: host }],
      ),
    ).toBe(false);
    // Also when the path-bearing value is an enum choice, not the default.
    const hostChoice = { host: { default: 'api.example.com', enum: ['api.example.com', 'api.example.com/v1'] } };
    expect(
      serverListsEqual(
        [{ url: 'https://{host}:443/v2', variables: hostChoice }],
        [{ url: 'https://{host}/v2', variables: hostChoice }],
      ),
    ).toBe(false);
    // Literal spellings of the same thing are still one server.
    expect(serverListsEqual([{ url: 'https://api.example.com:443/v2' }], [{ url: 'https://api.example.com/v2' }])).toBe(
      true,
    );
    expect(serverListsEqual([regional], [{ ...regional, url: 'https://eu.api.example.com' }])).toBe(false);
    // Variable values stay as written.
    expect(
      serverListsEqual(
        [regional],
        [{ ...regional, variables: { region: { default: 'EU', enum: ['eu', 'us'], description: 'The region.' } } }],
      ),
    ).toBe(false);
  });

  it('is false on a different variable name, default, enum, enum order or description', () => {
    const variant = (variables: ServerEntry['variables']): ServerEntry[] => [{ ...regional, variables }];
    expect(serverListsEqual([regional], variant({ zone: regional.variables!.region }))).toBe(false);
    expect(serverListsEqual([regional], variant({ region: { ...regional.variables!.region, default: 'us' } }))).toBe(
      false,
    );
    expect(serverListsEqual([regional], variant({ region: { ...regional.variables!.region, enum: ['eu'] } }))).toBe(
      false,
    );
    expect(
      serverListsEqual([regional], variant({ region: { ...regional.variables!.region, enum: ['us', 'eu'] } })),
    ).toBe(false);
    expect(
      serverListsEqual([regional], variant({ region: { ...regional.variables!.region, description: 'Other' } })),
    ).toBe(false);
    expect(serverListsEqual([regional], variant({ ...regional.variables, extra: { default: 'x' } }))).toBe(false);
    expect(serverListsEqual([regional], variant(undefined))).toBe(false);
  });

  it('compares a variable named like an Object.prototype member by its own key', () => {
    // Own data properties, as the parser builds them (never set through `obj[name] = …`).
    const withProto = (defaultValue: string): ServerEntry => ({
      url: 'https://{__proto__}.example.com/{constructor}',
      variables: Object.fromEntries([
        ['__proto__', { default: defaultValue }],
        ['constructor', { default: 'ctor' }],
      ]),
    });
    expect(serverListsEqual([withProto('eu')], [withProto('eu')])).toBe(true);
    expect(serverListsEqual([withProto('eu')], [withProto('us')])).toBe(false);
    // A list with no `__proto__` variable at all does not match one that has it.
    expect(
      serverListsEqual(
        [withProto('eu')],
        [{ url: 'https://{__proto__}.example.com/{constructor}', variables: { constructor: { default: 'ctor' } } }],
      ),
    ).toBe(false);
  });
});
