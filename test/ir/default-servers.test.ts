import { describe, expect, it } from 'vitest';
import {
  baseUrlBeyondDefault,
  isDefaultServerEntry,
  isDefaultServerList,
  serversOrDefault,
} from '../../src/ir/server-url.js';
import type { ServerEntry } from '../../src/ir/types.js';

/**
 * Covers the default-server helpers (issue #291): the three spellings of
 * OpenAPI's default server — no `servers`, `servers: []` and
 * `servers: [{ url: '/' }]` — read as one thing wherever the parser or the
 * differ compares server lists, and `/` is the same address as `''`.
 */
const root: ServerEntry = { url: '/' };
const staging: ServerEntry = { url: 'https://staging.api.example.com' };
const rootWithVariable: ServerEntry = { url: '/', variables: { port: { default: '443' } } };
const rootTemplate: ServerEntry = { url: '{root}', variables: { root: { default: '/' } } };

describe('isDefaultServerEntry', () => {
  it('is true for `/`', () => {
    expect(isDefaultServerEntry(root)).toBe(true);
  });

  it('ignores the description', () => {
    expect(isDefaultServerEntry({ url: '/', description: 'Same origin' })).toBe(true);
    expect(isDefaultServerEntry({ url: '/', description: undefined })).toBe(true);
  });

  it('treats an empty `variables` object like none', () => {
    expect(isDefaultServerEntry({ url: '/', variables: {} })).toBe(true);
  });

  it('is true for `/` with a variable: `/` references none, so it is not a knob a caller can set (#292)', () => {
    expect(isDefaultServerEntry(rootWithVariable)).toBe(true);
    expect(
      isDefaultServerEntry({
        url: '/',
        description: 'Same origin',
        variables: { port: { default: '443', enum: ['443', '8443'] } },
      }),
    ).toBe(true);
  });

  it('ignores a variable named like an Object.prototype member like any other', () => {
    const variables = Object.fromEntries([['__proto__', { default: 'x' }]]);
    expect(Object.hasOwn(variables, '__proto__')).toBe(true);
    expect(isDefaultServerEntry({ url: '/', variables })).toBe(true);
  });

  it('is false for a template that merely resolves to `/`', () => {
    expect(isDefaultServerEntry(rootTemplate)).toBe(false);
  });

  it('is false for any other URL', () => {
    expect(isDefaultServerEntry(staging)).toBe(false);
    expect(isDefaultServerEntry({ url: '/v1' })).toBe(false);
    expect(isDefaultServerEntry({ url: '//' })).toBe(false);
    expect(isDefaultServerEntry({ url: ' /' })).toBe(false);
  });
});

describe('isDefaultServerList', () => {
  it('is true for no list, an empty list, and `/` alone', () => {
    expect(isDefaultServerList(undefined)).toBe(true);
    expect(isDefaultServerList([])).toBe(true);
    expect(isDefaultServerList([root])).toBe(true);
  });

  it('is true for `/` written out more than once', () => {
    expect(isDefaultServerList([root, root])).toBe(true);
    expect(isDefaultServerList([root, { url: '/', description: 'Same origin' }])).toBe(true);
  });

  it('is false for `/` beside another server, in either position', () => {
    expect(isDefaultServerList([root, staging])).toBe(false);
    expect(isDefaultServerList([staging, root])).toBe(false);
  });

  it('is true for `/` with a variable, which references none (#292), and false for a template that resolves to `/`', () => {
    expect(isDefaultServerList([rootWithVariable])).toBe(true);
    expect(isDefaultServerList([root, rootWithVariable])).toBe(true);
    expect(isDefaultServerList([rootTemplate])).toBe(false);
  });

  it('is false for any other list', () => {
    expect(isDefaultServerList([staging])).toBe(false);
    expect(isDefaultServerList([{ url: '/v1' }])).toBe(false);
  });
});

describe('serversOrDefault', () => {
  it("is OpenAPI's single `/` for every spelling of the default", () => {
    expect(serversOrDefault(undefined)).toEqual([{ url: '/' }]);
    expect(serversOrDefault([])).toEqual([{ url: '/' }]);
    expect(serversOrDefault([root])).toEqual([{ url: '/' }]);
    expect(serversOrDefault([{ url: '/', description: 'Same origin' }])).toEqual([{ url: '/' }]);
    expect(serversOrDefault([root, root])).toEqual([{ url: '/' }]);
    // `/` references no variable, so one declared on it is still only the default (#292).
    expect(serversOrDefault([rootWithVariable])).toEqual([{ url: '/' }]);
    expect(serversOrDefault([root, rootWithVariable])).toEqual([{ url: '/' }]);
  });

  it('is the list itself, not a copy, when it declares anything beyond the default', () => {
    for (const list of [[staging], [root, staging], [staging, root], [rootWithVariable, staging], [rootTemplate]]) {
      expect(serversOrDefault(list)).toBe(list);
    }
  });
});

describe('baseUrlBeyondDefault', () => {
  it("reads `''` and `/` as one address, `''`", () => {
    expect(baseUrlBeyondDefault('')).toBe('');
    expect(baseUrlBeyondDefault('/')).toBe('');
  });

  it('leaves any other address as written', () => {
    expect(baseUrlBeyondDefault('https://api.example.com')).toBe('https://api.example.com');
    expect(baseUrlBeyondDefault('/v1')).toBe('/v1');
    expect(baseUrlBeyondDefault('//')).toBe('//');
    expect(baseUrlBeyondDefault(' /')).toBe(' /');
  });
});
