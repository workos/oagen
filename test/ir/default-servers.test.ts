import { describe, expect, it } from 'vitest';
import { isDefaultServerList, serversBeyondDefault } from '../../src/ir/server-url.js';
import type { ServerEntry } from '../../src/ir/types.js';

/**
 * Covers `isDefaultServerList` and `serversBeyondDefault` (issue #291): the
 * three spellings of OpenAPI's default server — no `servers`, `servers: []`
 * and `servers: [{ url: '/' }]` — read as one thing wherever the parser or
 * the differ compares server lists.
 */
describe('isDefaultServerList', () => {
  const root: ServerEntry = { url: '/' };
  const staging: ServerEntry = { url: 'https://staging.api.example.com' };

  it('is true for no list, an empty list, and `/` alone', () => {
    expect(isDefaultServerList(undefined)).toBe(true);
    expect(isDefaultServerList([])).toBe(true);
    expect(isDefaultServerList([root])).toBe(true);
  });

  it('ignores the description of the `/` entry', () => {
    expect(isDefaultServerList([{ url: '/', description: 'Same origin' }])).toBe(true);
    expect(isDefaultServerList([{ url: '/', description: undefined }])).toBe(true);
  });

  it('treats an empty `variables` object like none', () => {
    expect(isDefaultServerList([{ url: '/', variables: {} }])).toBe(true);
  });

  it('is true for `/` with a variable: `/` references none, so it is not a knob a caller can set (#292)', () => {
    expect(isDefaultServerList([{ url: '/', variables: { port: { default: '443' } } }])).toBe(true);
    expect(
      isDefaultServerList([
        { url: '/', description: 'Same origin', variables: { port: { default: '443', enum: ['443', '8443'] } } },
      ]),
    ).toBe(true);
  });

  it('ignores a variable named like an Object.prototype member like any other', () => {
    const variables = Object.fromEntries([['__proto__', { default: 'x' }]]);
    expect(Object.hasOwn(variables, '__proto__')).toBe(true);
    expect(isDefaultServerList([{ url: '/', variables }])).toBe(true);
  });

  it('is false for a template that merely resolves to `/`', () => {
    expect(isDefaultServerList([{ url: '{root}', variables: { root: { default: '/' } } }])).toBe(false);
  });

  it('is false for `/` beside another server, in either position, or declared twice', () => {
    expect(isDefaultServerList([root, staging])).toBe(false);
    expect(isDefaultServerList([staging, root])).toBe(false);
    expect(isDefaultServerList([root, root])).toBe(false);
  });

  it('is false for any other single URL', () => {
    expect(isDefaultServerList([staging])).toBe(false);
    expect(isDefaultServerList([{ url: '/v1' }])).toBe(false);
    expect(isDefaultServerList([{ url: '//' }])).toBe(false);
    expect(isDefaultServerList([{ url: ' /' }])).toBe(false);
  });
});

describe('serversBeyondDefault', () => {
  it('is an empty list for every spelling of the default', () => {
    expect(serversBeyondDefault(undefined)).toEqual([]);
    expect(serversBeyondDefault([])).toEqual([]);
    expect(serversBeyondDefault([{ url: '/' }])).toEqual([]);
    expect(serversBeyondDefault([{ url: '/', description: 'Same origin' }])).toEqual([]);
    // `/` references no variable, so one declared on it is not a server beyond the default (#292).
    expect(serversBeyondDefault([{ url: '/', variables: { port: { default: '443' } } }])).toEqual([]);
  });

  it('is the list itself, not a copy, for anything else', () => {
    const staging: ServerEntry[] = [{ url: 'https://staging.api.example.com' }];
    expect(serversBeyondDefault(staging)).toBe(staging);

    const rootTemplate: ServerEntry[] = [{ url: '{root}', variables: { root: { default: '/' } } }];
    expect(serversBeyondDefault(rootTemplate)).toBe(rootTemplate);

    const rootBesideHost: ServerEntry[] = [{ url: '/' }, ...staging];
    expect(serversBeyondDefault(rootBesideHost)).toBe(rootBesideHost);
  });
});
