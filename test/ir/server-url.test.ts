import { describe, expect, it } from 'vitest';
import { resolveServerUrl, serverUrlPlaceholders } from '../../src/ir/server-url.js';
import type { ServerVariable } from '../../src/ir/types.js';

/**
 * Covers `resolveServerUrl` in isolation: how a server URL template and its
 * variables become a concrete URL. The parser's use of it for `baseUrl` is
 * covered in test/parser/servers.test.ts. `serverUrlPlaceholders`, which
 * reads the same template by the same scan, is covered at the end.
 */
describe('resolveServerUrl', () => {
  it("replaces a placeholder with its variable's default", () => {
    const resolved = resolveServerUrl({
      url: 'https://{region}.api.example.com/v1',
      variables: { region: { default: 'eu', enum: ['eu', 'us'] } },
    });
    expect(resolved).toEqual({ url: 'https://eu.api.example.com/v1', unresolved: [] });
  });

  it('replaces every occurrence of a variable used more than once', () => {
    const resolved = resolveServerUrl({
      url: 'https://{env}.example.com/{env}/v1',
      variables: { env: { default: 'staging' } },
    });
    expect(resolved).toEqual({ url: 'https://staging.example.com/staging/v1', unresolved: [] });
  });

  it('resolves several variables in one template', () => {
    const resolved = resolveServerUrl({
      url: '{scheme}://{host}:{port}/v1',
      variables: {
        scheme: { default: 'https' },
        host: { default: 'api.example.com' },
        port: { default: '8443' },
      },
    });
    expect(resolved).toEqual({ url: 'https://api.example.com:8443/v1', unresolved: [] });
  });

  it('keeps an undeclared placeholder and reports it once', () => {
    const resolved = resolveServerUrl({
      url: 'https://{region}.example.com/{region}/{tenant}',
      variables: { tenant: { default: 'acme' } },
    });
    expect(resolved).toEqual({ url: 'https://{region}.example.com/{region}/acme', unresolved: ['region'] });
  });

  it('lists unresolved names in order of first appearance', () => {
    const resolved = resolveServerUrl({ url: 'https://{b}.{a}.{b}.example.com' });
    expect(resolved.unresolved).toEqual(['b', 'a']);
  });

  it('ignores a declared variable the template never mentions', () => {
    const resolved = resolveServerUrl({
      url: 'https://api.example.com/v1',
      variables: { region: { default: 'eu' } },
    });
    expect(resolved).toEqual({ url: 'https://api.example.com/v1', unresolved: [] });
  });

  it('passes a URL without placeholders through, relative ones included', () => {
    expect(resolveServerUrl({ url: 'https://api.example.com' })).toEqual({
      url: 'https://api.example.com',
      unresolved: [],
    });
    expect(resolveServerUrl({ url: '/v1' })).toEqual({ url: '/v1', unresolved: [] });
    expect(resolveServerUrl({ url: '' })).toEqual({ url: '', unresolved: [] });
  });

  it('does not scan the substituted value again', () => {
    // `{other}` arrives as text; it is neither resolved nor reported.
    const resolved = resolveServerUrl({
      url: 'https://{region}.example.com',
      variables: { region: { default: '{other}' }, other: { default: 'nope' } },
    });
    expect(resolved).toEqual({ url: 'https://{other}.example.com', unresolved: [] });
  });

  it('treats an unclosed brace as literal text', () => {
    const resolved = resolveServerUrl({
      url: 'https://{region.example.com',
      variables: { region: { default: 'eu' } },
    });
    expect(resolved).toEqual({ url: 'https://{region.example.com', unresolved: [] });
  });

  it('treats an empty `{}` as literal text', () => {
    expect(resolveServerUrl({ url: 'https://{}.example.com' })).toEqual({
      url: 'https://{}.example.com',
      unresolved: [],
    });
  });

  it('treats a brace reopened before it closes as literal text', () => {
    const resolved = resolveServerUrl({
      url: 'https://{a{region}.example.com',
      variables: { region: { default: 'eu' } },
    });
    expect(resolved).toEqual({ url: 'https://{aeu.example.com', unresolved: [] });
  });

  it('matches a variable name with regex metacharacters as written', () => {
    const resolved = resolveServerUrl({
      url: 'https://{a.b+c}.example.com/{a.b+c}',
      variables: { 'a.b+c': { default: 'x' } },
    });
    expect(resolved).toEqual({ url: 'https://x.example.com/x', unresolved: [] });
  });

  it('does not resolve a placeholder from Object.prototype', () => {
    const resolved = resolveServerUrl({
      url: 'https://{constructor}.{toString}.example.com',
      variables: { region: { default: 'eu' } },
    });
    expect(resolved).toEqual({
      url: 'https://{constructor}.{toString}.example.com',
      unresolved: ['constructor', 'toString'],
    });
  });

  it('substitutes an empty default', () => {
    const resolved = resolveServerUrl({
      url: 'https://api.example.com/{prefix}v1',
      variables: { prefix: { default: '' } },
    });
    expect(resolved).toEqual({ url: 'https://api.example.com/v1', unresolved: [] });
  });

  it('resolves variables named like Object.prototype members when they are own keys', () => {
    // Object.fromEntries defines own data properties, `__proto__` included —
    // the same way the parser materializes `ServerEntry.variables`.
    const variables: Record<string, ServerVariable> = Object.fromEntries<ServerVariable>([
      ['__proto__', { default: 'eu' }],
      ['constructor', { default: 'ctor' }],
      ['hasOwnProperty', { default: 'own' }],
      ['toString', { default: 'str' }],
    ]);
    expect(Object.hasOwn(variables, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(variables)).toBe(Object.prototype);

    const resolved = resolveServerUrl({
      url: 'https://{__proto__}.example.com/{constructor}/{hasOwnProperty}/{toString}/{__proto__}',
      variables,
    });
    expect(resolved).toEqual({ url: 'https://eu.example.com/ctor/own/str/eu', unresolved: [] });
  });

  it('does not resolve `{__proto__}` from the prototype chain', () => {
    // In an object literal `__proto__:` sets the prototype rather than an own
    // key, so this map declares nothing as far as the resolver is concerned.
    const variables = { __proto__: { default: 'eu' } } as Record<string, ServerVariable>;
    expect(Object.hasOwn(variables, '__proto__')).toBe(false);

    const resolved = resolveServerUrl({ url: 'https://{__proto__}.example.com', variables });
    expect(resolved).toEqual({ url: 'https://{__proto__}.example.com', unresolved: ['__proto__'] });
  });
});

describe('serverUrlPlaceholders', () => {
  it('lists the placeholder names in order of first appearance, without repeats', () => {
    expect(serverUrlPlaceholders('https://{region}.example.com:{port}/{region}')).toEqual(['region', 'port']);
  });

  it('lists nothing for a template without placeholders, a relative one included', () => {
    expect(serverUrlPlaceholders('https://api.example.com/v1')).toEqual([]);
    expect(serverUrlPlaceholders('/')).toEqual([]);
    expect(serverUrlPlaceholders('')).toEqual([]);
  });

  it('reads the template alone, whether or not a variable is declared for a name', () => {
    const server = { url: 'https://{region}.example.com', variables: { tenant: { default: 'acme' } } };
    // `tenant` is declared but never referenced; `region` is referenced but
    // never declared. The placeholders are what the template says.
    expect(serverUrlPlaceholders(server.url)).toEqual(['region']);
    expect(resolveServerUrl(server).unresolved).toEqual(['region']);
  });

  it('reads braces as resolveServerUrl does: unclosed, empty and reopened ones are literal', () => {
    expect(serverUrlPlaceholders('https://{region.example.com')).toEqual([]);
    expect(serverUrlPlaceholders('https://{}.example.com')).toEqual([]);
    expect(serverUrlPlaceholders('https://{a{region}.example.com')).toEqual(['region']);
    // A well-formed placeholder after a literal brace is still found.
    expect(serverUrlPlaceholders('https://{}.example.com/{version}')).toEqual(['version']);
  });

  it('keeps a name with regex metacharacters as written', () => {
    expect(serverUrlPlaceholders('https://{a.b+c}.example.com/{a.b+c}')).toEqual(['a.b+c']);
  });

  it('lists a name like an Object.prototype member as itself', () => {
    expect(serverUrlPlaceholders('https://{__proto__}.example.com/{constructor}/{toString}')).toEqual([
      '__proto__',
      'constructor',
      'toString',
    ]);
  });

  it('agrees with resolveServerUrl: with no variables declared, every placeholder is unresolved', () => {
    for (const url of [
      'https://{region}.example.com:{port}/{region}',
      'https://{a{region}.example.com',
      'https://{}.example.com/{version}',
      'https://{region.example.com',
      '{scheme}://{host}:{port}/v1',
    ]) {
      expect(resolveServerUrl({ url }).unresolved).toEqual(serverUrlPlaceholders(url));
    }
  });
});
