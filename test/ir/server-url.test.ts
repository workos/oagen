import { describe, expect, it } from 'vitest';
import { normalizeServerUrl, resolveServerUrl, serverUrlPlaceholders } from '../../src/ir/server-url.js';
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

/**
 * Covers `normalizeServerUrl` (issue #293): the RFC 3986 form two equivalent
 * spellings of a server URL share, used wherever the parser or the differ
 * compares server URLs. The IR itself keeps every URL as written.
 */
describe('normalizeServerUrl', () => {
  /** Every spelling in `urls` normalises to `expected`. */
  function expectSame(expected: string, urls: string[]): void {
    for (const url of urls) expect(normalizeServerUrl(url), url).toBe(expected);
  }

  it("lower-cases the scheme and the host, the issue's case", () => {
    expectSame('https://pets.example.com/', [
      'https://pets.example.com',
      'https://PETS.example.com',
      'HTTPS://pets.example.com',
      'Https://Pets.Example.COM',
    ]);
  });

  it('keeps the case of the path, query and fragment', () => {
    expect(normalizeServerUrl('https://pets.example.com/V1')).toBe('https://pets.example.com/V1');
    expect(normalizeServerUrl('https://pets.example.com/V1')).not.toBe(
      normalizeServerUrl('https://pets.example.com/v1'),
    );
    expect(normalizeServerUrl('https://PETS.example.com/v1?Key=Value#Frag')).toBe(
      'https://pets.example.com/v1?Key=Value#Frag',
    );
  });

  it('keeps the case of userinfo and lower-cases only the host after it', () => {
    expect(normalizeServerUrl('https://User:Pass@API.example.com')).toBe('https://User:Pass@api.example.com/');
  });

  it("drops a port that is the scheme's default, or empty", () => {
    expectSame('https://pets.example.com/', ['https://pets.example.com:443', 'https://pets.example.com:']);
    expectSame('http://pets.example.com/v1', ['http://pets.example.com:80/v1', 'http://pets.example.com/v1']);
    expectSame('ws://pets.example.com/', ['ws://pets.example.com:80']);
    expectSame('wss://pets.example.com/', ['wss://pets.example.com:443']);
    // Read as a number, so a leading zero does not make 443 another port.
    expect(normalizeServerUrl('https://pets.example.com:0443')).toBe('https://pets.example.com/');
  });

  it('keeps any other port, and a port the scheme has no default for', () => {
    expect(normalizeServerUrl('https://pets.example.com:8443')).toBe('https://pets.example.com:8443/');
    expect(normalizeServerUrl('http://pets.example.com:443')).toBe('http://pets.example.com:443/');
    expect(normalizeServerUrl('ftp://pets.example.com:21')).toBe('ftp://pets.example.com:21/');
  });

  it('reads the port after an IPv6 literal, never a colon inside it', () => {
    expect(normalizeServerUrl('https://[2001:DB8::1]:443/x')).toBe('https://[2001:db8::1]/x');
    expect(normalizeServerUrl('https://[2001:DB8::1]:8080')).toBe('https://[2001:db8::1]:8080/');
    expect(normalizeServerUrl('https://[::1]')).toBe('https://[::1]/');
  });

  it('gives an authority with no path the path `/`, and changes no other path', () => {
    expectSame('https://pets.example.com/', ['https://pets.example.com', 'https://pets.example.com/']);
    expect(normalizeServerUrl('https://pets.example.com?x=1')).toBe('https://pets.example.com/?x=1');
    expect(normalizeServerUrl('https://pets.example.com/v1/')).toBe('https://pets.example.com/v1/');
    expect(normalizeServerUrl('https://pets.example.com/v1/')).not.toBe(
      normalizeServerUrl('https://pets.example.com/v1'),
    );
    expect(normalizeServerUrl('https://pets.example.com/v1/../v2')).toBe('https://pets.example.com/v1/../v2');
  });

  it('upper-cases percent-encoded hex digits and decodes an unreserved character', () => {
    expect(normalizeServerUrl('https://pets.example.com/%7eapi/%2f/%zz/%4')).toBe(
      'https://pets.example.com/~api/%2F/%zz/%4',
    );
    // Decoded before the host is folded.
    expect(normalizeServerUrl('https://%41PI.example.com')).toBe('https://api.example.com/');
    // The host is lower-cased outside its octets, whose hex digits stay upper-cased (MichaelDeBoey).
    expectSame('https://p%C3%A9ts.example.com/', ['https://p%C3%A9ts.EXAMPLE.com', 'https://P%c3%a9TS.example.com']);
    expect(normalizeServerUrl('https://p%C3%A9ts.example.com')).not.toContain('%c3');
  });

  it('keeps every placeholder as written, wherever it sits', () => {
    // After the first placeholder in the authority nothing is folded.
    expect(normalizeServerUrl('HTTPS://{region}.API.example.com/{version}')).toBe(
      'https://{region}.API.example.com/{version}',
    );
    expect(normalizeServerUrl('https://{Region}.api.example.com')).toBe('https://{Region}.api.example.com');
    expect(normalizeServerUrl('HTTPS://API.example.com{basePath}')).toBe('https://API.example.com{basePath}');
    expect(normalizeServerUrl('HTTPS://API.example.com:443/{version}')).toBe('https://api.example.com/{version}');
    expect(normalizeServerUrl('HTTPS://API.example.com?{q}')).toBe('https://api.example.com/?{q}');
    expect(normalizeServerUrl('https://{Region}.api.example.com')).not.toBe(
      normalizeServerUrl('https://{region}.api.example.com'),
    );
    expect(normalizeServerUrl('{scheme}://{host}:{port}/{basePath}')).toBe('{scheme}://{host}:{port}/{basePath}');
    expect(normalizeServerUrl('https://api.example.com/{v}?x={y}')).toBe('https://api.example.com/{v}?x={y}');
  });

  it('never confuses a template with what it resolves to', () => {
    expect(normalizeServerUrl('https://{region}.api.example.com')).not.toBe(
      normalizeServerUrl('https://eu.api.example.com'),
    );
  });

  it('keeps a port written as a placeholder, and folds nothing after a placeholder scheme', () => {
    expect(normalizeServerUrl('https://api.example.com:{port}')).toBe('https://api.example.com:{port}');
    expect(normalizeServerUrl('{scheme}://API.example.com:443')).toBe('{scheme}://API.example.com:443');
  });

  it('keeps the authority as written from its first placeholder on, which may supply a port or a path (Greptile)', () => {
    // `basePath` defaulting to `/v1` makes these resolve to `/v1` and `/v1/`.
    expect(normalizeServerUrl('https://api.example.com{basePath}')).toBe('https://api.example.com{basePath}');
    expect(normalizeServerUrl('https://api.example.com{basePath}/')).toBe('https://api.example.com{basePath}/');
    expect(normalizeServerUrl('https://api.example.com{basePath}')).not.toBe(
      normalizeServerUrl('https://api.example.com{basePath}/'),
    );
    expect(normalizeServerUrl('https://{host}')).toBe('https://{host}');
    expect(normalizeServerUrl('https://API.example.com:{port}?x=1')).toBe('https://API.example.com:{port}?x=1');
    // `host` defaulting to `api.example.com/v1` makes `:443` path text, so no
    // port is dropped and no `/` added after a placeholder.
    expect(normalizeServerUrl('https://{host}:443/v2')).toBe('https://{host}:443/v2');
    expect(normalizeServerUrl('https://{host}:443/v2')).not.toBe(normalizeServerUrl('https://{host}/v2'));
    expect(normalizeServerUrl('https://{host}:443')).not.toBe(normalizeServerUrl('https://{host}:443/'));
    expect(normalizeServerUrl('https://{region}.API.example.com:443')).toBe('https://{region}.API.example.com:443');
    expect(normalizeServerUrl('https://{host}:8443')).toBe('https://{host}:8443');
    // A `@` after the placeholder makes the text before it userinfo: kept as written.
    expect(normalizeServerUrl('https://USER{x}@HOST.example.com')).toBe('https://USER{x}@HOST.example.com');
    // The same literal spellings still fold.
    expectSame('https://api.example.com/v2', ['https://api.example.com:443/v2', 'https://api.example.com/v2']);
    // A bare literal authority still gets `/`.
    expectSame('https://api.example.com/', ['https://api.example.com', 'https://api.example.com/']);
  });

  it('folds nothing whose URL part an earlier placeholder could change (Greptile, round 3)', () => {
    // `suffix` defaulting to `@api.example.com` makes `USER` a username, which
    // keeps its case: the text before a placeholder in the authority is kept.
    expect(normalizeServerUrl('https://USER{suffix}/v1')).toBe('https://USER{suffix}/v1');
    expect(normalizeServerUrl('https://USER{suffix}/v1')).not.toBe(normalizeServerUrl('https://user{suffix}/v1'));
    // `prefix` defaulting to `https://gateway.example.com/path` makes the rest
    // a path: a template whose scheme holds a placeholder is kept whole.
    expect(normalizeServerUrl('{prefix}://api.example.com')).toBe('{prefix}://api.example.com');
    expect(normalizeServerUrl('{prefix}://api.example.com')).not.toBe(
      normalizeServerUrl('{prefix}://api.example.com/'),
    );
    expect(normalizeServerUrl('{prefix}://API.example.com:443')).toBe('{prefix}://API.example.com:443');
    expect(normalizeServerUrl('https{x}://API.example.com')).toBe('https{x}://API.example.com');
    // Mirror cases: a part that is complete before the first placeholder still folds.
    expectSame('https://api.example.com/{version}', [
      'HTTPS://API.example.com:443/{version}',
      'https://api.example.com/{version}',
    ]);
    expectSame('https://api.example.com/x?{q}', ['HTTPS://API.example.com:/x?{q}', 'https://api.example.com/x?{q}']);
    expectSame('https://{region}.api.example.com', [
      'HTTPS://{region}.api.example.com',
      'Https://{region}.api.example.com',
    ]);
    expectSame('https://pets.example.com/', ['HTTPS://PETS.example.com:443', 'https://pets.example.com/']);
  });

  it('keeps percent-encoding as written from the first placeholder up to the next `/`, `?` or `#` (MichaelDeBoey)', () => {
    // A value may put that text in a scheme or a port, where `%` has no
    // meaning: `scheme` = `http` resolves these to `http%73://…` and `https://…`.
    expect(normalizeServerUrl('{scheme}%73://notes.example.com')).toBe('{scheme}%73://notes.example.com');
    expect(normalizeServerUrl('{scheme}s://notes.example.com')).toBe('{scheme}s://notes.example.com');
    expect(normalizeServerUrl('{scheme}%73://notes.example.com')).not.toBe(
      normalizeServerUrl('{scheme}s://notes.example.com'),
    );
    // `x` = `:` makes `%34%34%33` a port that keeps its encoding, where `443` is dropped.
    expect(normalizeServerUrl('https://notes.example.com{x}%34%34%33')).toBe('https://notes.example.com{x}%34%34%33');
    expect(normalizeServerUrl('https://notes.example.com{x}%34%34%33')).not.toBe(
      normalizeServerUrl('https://notes.example.com{x}443'),
    );
    expect(normalizeServerUrl('https://{host}%7e')).toBe('https://{host}%7e');
    // Nothing from the first placeholder on is folded, even past a `/`: a
    // value such as `https:/` can make the text after it an authority with a
    // port, and one ending in `%` can join with it into another octet.
    // Before the placeholder, in a path, a complete octet folds.
    expect(normalizeServerUrl('https://{host}/%7e?%7e#%7e')).toBe('https://{host}/%7e?%7e#%7e');
    expect(normalizeServerUrl('https://api.example.com/%7e{x}%7e/%7e')).toBe('https://api.example.com/~{x}%7e/%7e');
    expect(normalizeServerUrl('{x}%7e/%7e')).toBe('{x}%7e/%7e');
  });

  it('folds nothing a placeholder value could join or re-part, in the authority or after a `/` (Greptile, merge round)', () => {
    // `port` = `43`: `:443` vs the invalid `:%3443`, so the text before the
    // placeholder in its authority is kept as written too.
    expect(normalizeServerUrl('https://api.example.com:4{port}')).toBe('https://api.example.com:4{port}');
    expect(normalizeServerUrl('https://api.example.com:%34{port}')).toBe('https://api.example.com:%34{port}');
    expect(normalizeServerUrl('https://api.example.com:4{port}')).not.toBe(
      normalizeServerUrl('https://api.example.com:%34{port}'),
    );
    // A placeholder scheme leaves the `//…` an authority whose port is not decoded.
    expect(normalizeServerUrl('{scheme}://host:%34%34%33')).toBe('{scheme}://host:%34%34%33');
    expect(normalizeServerUrl('{scheme}://host:%34%34%33')).not.toBe(normalizeServerUrl('{scheme}://host:443'));
    // `x` = `%`: `/%7e` vs `/%%37e`, so text beside a later placeholder is kept as written.
    expect(normalizeServerUrl('https://{host}/{x}7e')).toBe('https://{host}/{x}7e');
    expect(normalizeServerUrl('https://{host}/{x}%37e')).toBe('https://{host}/{x}%37e');
    expect(normalizeServerUrl('https://{host}/{x}7e')).not.toBe(normalizeServerUrl('https://{host}/{x}%37e'));
    // Mirrors: a complete octet before the first placeholder in a path, and a
    // literal authority's port, still fold.
    expectSame('https://api.example.com/~{x}', ['https://api.example.com/%7e{x}', 'https://api.example.com/~{x}']);
    expectSame('https://api.example.com/{x}', ['https://api.example.com:443/{x}', 'HTTPS://API.example.com/{x}']);
  });

  it('never folds two templates to one that resolve apart under some allowed value (soundness)', () => {
    // Every template below, with every variable allowed every value below:
    // whenever two templates come out as one string, they must resolve to
    // one normalised URL under the defaults and under each single
    // substitution. Rounds 1 to 3 of review were each an instance of this.
    const templates = [
      'https://api.example.com',
      'https://api.example.com/',
      'HTTPS://API.example.com:443',
      'https://api.example.com/v1',
      'https://api.example.com/v1/',
      'https://api.example.com{basePath}',
      'https://api.example.com{basePath}/',
      'https://{host}',
      'https://{host}/',
      'https://{host}:443/v2',
      'https://{host}/v2',
      'https://USER{suffix}/v1',
      'https://user{suffix}/v1',
      '{prefix}://api.example.com',
      '{prefix}://api.example.com/',
      '{prefix}://API.example.com',
      'https://{region}.api.example.com',
      'HTTPS://{region}.api.example.com',
      'https://{region}.API.example.com',
      'https://api.example.com:{port}',
      'https://api.example.com:{port}/',
      'https://api.example.com/{version}',
      'HTTPS://API.example.com:443/{version}',
      'https://api.example.com/%7e{x}',
      'https://api.example.com/~{x}',
      'https://api.example.com/{x}%7e',
      'https://api.example.com/{x}~',
      'https://{host}/%7e',
      'https://{host}/~',
      '{scheme}%73://notes.example.com',
      '{scheme}s://notes.example.com',
      'https://notes.example.com{x}%34%34%33',
      'https://notes.example.com{x}443',
      'https://p%C3%A9ts.EXAMPLE.com',
      'https://P%c3%a9TS.example.com',
      'https://api.example.com:4{port}',
      'https://api.example.com:%34{port}',
      '{scheme}://host:%34%34%33',
      '{scheme}://host:443',
      'https://{host}/{x}7e',
      'https://{host}/{x}%37e',
      'https://api.example.com/{x}/%7e',
      'https://api.example.com/{x}/~',
      'https://api.example.com/{x}/7e',
      'https://USER:pw@API.example.com',
      'https://[2001:DB8::1]:443/{x}',
      '//{host}/v1',
      '/{v}',
      '/v1',
      '{x}',
      'https{x}://api.example.com',
      'https://{a}{b}',
      'https://{a}/{b}',
      'https://api.example.com/{a}?{b}',
    ];
    const values = [
      'x',
      'X',
      '',
      '@api.example.com',
      'api.example.com/v1',
      'https://gateway.example.com/path',
      ':8443',
      '/x?y#z',
      '%7e',
      '//evil.example.com',
      'A@B:443',
      ':',
      'http',
      'https',
      'https:/',
      '%',
      '%3',
      '%7',
      '7e',
      '43',
      'e',
    ];
    const names = ['basePath', 'host', 'suffix', 'prefix', 'region', 'port', 'version', 'x', 'v', 'a', 'b', 'scheme'];
    const variables = Object.fromEntries(names.map((name) => [name, { default: 'x', enum: values }]));
    /** The variables with one of them set to `value`. */
    const withValue = (name: string, value: string) =>
      Object.fromEntries(names.map((n) => [n, n === name ? { default: value, enum: values } : variables[n]]));
    const resolved = (url: string, vars: typeof variables) =>
      normalizeServerUrl(resolveServerUrl({ url, variables: vars }).url);

    let folded = 0;
    for (const a of templates) {
      for (const b of templates) {
        if (a >= b || normalizeServerUrl(a) !== normalizeServerUrl(b)) continue;
        folded++;
        expect(resolved(a, variables), `${a} vs ${b}`).toBe(resolved(b, variables));
        for (const name of names) {
          for (const value of values) {
            const vars = withValue(name, value);
            expect(resolved(a, vars), `${a} vs ${b} with ${name}=${value}`).toBe(resolved(b, vars));
          }
        }
      }
    }
    // The corpus does fold some pairs, so the check above is not vacuous.
    expect(folded).toBeGreaterThanOrEqual(6);
  });

  it('treats an unclosed brace, an empty `{}` and a reopened brace as literal text, like resolveServerUrl', () => {
    expect(normalizeServerUrl('https://API.example.com/{unclosed')).toBe('https://api.example.com/{unclosed');
    expect(normalizeServerUrl('https://API.example.com/{}')).toBe('https://api.example.com/{}');
    expect(normalizeServerUrl('https://API.example.com/{a{b}')).toBe('https://api.example.com/{a{b}');
  });

  it('applies the same rules to a relative reference', () => {
    expect(normalizeServerUrl('/')).toBe('/');
    expect(normalizeServerUrl('')).toBe('');
    expect(normalizeServerUrl('/v1')).toBe('/v1');
    expect(normalizeServerUrl('/V1')).toBe('/V1');
    // A network-path reference has a host to fold but no scheme, so no port is a default.
    expect(normalizeServerUrl('//API.example.com:443/v1')).toBe('//api.example.com:443/v1');
    expect(normalizeServerUrl('//API.example.com:/v1')).toBe('//api.example.com/v1');
    expect(normalizeServerUrl('api.example.com/v1')).toBe('api.example.com/v1');
  });

  it('reads `host:port` with no `//` as RFC 3986 does: a scheme and a path', () => {
    expect(normalizeServerUrl('LOCALHOST:8080/x')).toBe('localhost:8080/x');
  });

  it('reads braces as resolveServerUrl and serverUrlPlaceholders do: one scan for all three', () => {
    for (const url of [
      'https://{region}.EXAMPLE.com:{port}/{region}',
      'https://{a{region}.EXAMPLE.com',
      'https://{}.EXAMPLE.com/{version}',
      'https://{region.EXAMPLE.com',
      '{scheme}://{host}:{port}/v1',
    ]) {
      // Every placeholder the scan finds survives normalisation as written,
      // and nothing else is treated as one (a literal brace is a character
      // like any other).
      const normalized = normalizeServerUrl(url);
      for (const name of serverUrlPlaceholders(url)) expect(normalized).toContain(`{${name}}`);
      expect(serverUrlPlaceholders(normalized)).toEqual(serverUrlPlaceholders(url));
    }
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
