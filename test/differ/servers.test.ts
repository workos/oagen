import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { diffServers } from '../../src/differ/servers.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import { resolveServerUrl } from '../../src/ir/server-url.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, ServerEntry, ServerVariable } from '../../src/ir/types.js';

const fixtures = resolve(import.meta.dirname, '../fixtures');

/** A spec whose `baseUrl` is `servers[0]` resolved, the way the parser builds it. */
function spec(servers?: ServerEntry[]): ApiSpec {
  return {
    name: 'Test API',
    version: '1.0.0',
    baseUrl: servers?.[0] ? resolveServerUrl(servers[0]).url : '',
    servers,
    models: [],
    enums: [],
    services: [],
    sdk: defaultSdkBehavior(),
  };
}

function server(url: string, variables?: Record<string, ServerVariable>, description?: string): ServerEntry {
  return { url, ...(variables && { variables }), ...(description !== undefined && { description }) };
}

const regional = server('https://{region}.api.example.com', { region: { default: 'eu', enum: ['eu', 'us'] } });
const staging = server('https://staging.api.example.com');

describe('diffServers', () => {
  it('reports nothing for identical servers', () => {
    expect(diffServers(spec([regional, staging]), spec([regional, staging]))).toEqual([]);
  });

  it('reports nothing when neither spec declares a server', () => {
    expect(diffServers(spec(), spec())).toEqual([]);
    expect(diffServers(spec([]), spec())).toEqual([]);
  });

  describe('baseUrl', () => {
    it('reports a changed servers[0] template as base-url-changed plus a removal and an addition, once each', () => {
      const changes = diffServers(spec([regional]), spec([server('https://api.example.org')]));
      expect(changes).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://eu.api.example.com',
          newBaseUrl: 'https://api.example.org',
          classification: 'breaking',
        },
        { kind: 'server-added', url: 'https://api.example.org', classification: 'additive' },
        { kind: 'server-removed', url: 'https://{region}.api.example.com', classification: 'breaking' },
      ]);
    });

    it('reports a changed variable default on servers[0] as base-url-changed plus the server-modified that caused it', () => {
      const moved = server('https://{region}.api.example.com', { region: { default: 'us', enum: ['eu', 'us'] } });
      expect(diffServers(spec([regional]), spec([moved]))).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://eu.api.example.com',
          newBaseUrl: 'https://us.api.example.com',
          classification: 'breaking',
        },
        {
          kind: 'server-modified',
          url: 'https://{region}.api.example.com',
          variableChanges: [
            {
              kind: 'variable-default-changed',
              variableName: 'region',
              classification: 'breaking',
              oldDefault: 'eu',
              newDefault: 'us',
              details: "default changed from 'eu' to 'us'",
            },
          ],
          classification: 'breaking',
        },
      ]);
    });

    it('reports a reordered list as base-url-changed only', () => {
      const changes = diffServers(spec([regional, staging]), spec([staging, regional]));
      expect(changes).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://eu.api.example.com',
          newBaseUrl: 'https://staging.api.example.com',
          classification: 'breaking',
        },
      ]);
    });

    it('reports nothing when the list is reordered but servers[0] resolves to the same host', () => {
      const same = server('https://eu.api.example.com');
      expect(diffServers(spec([regional, same]), spec([same, regional]))).toEqual([]);
    });

    it('is additive when a spec with no server gains one, since callers had to name a host already', () => {
      expect(diffServers(spec(), spec([staging]))).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: '',
          newBaseUrl: 'https://staging.api.example.com',
          classification: 'additive',
        },
        { kind: 'server-added', url: 'https://staging.api.example.com', classification: 'additive' },
      ]);
    });

    it('is breaking when every server disappears, since the client loses its default host', () => {
      expect(diffServers(spec([staging]), spec())).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://staging.api.example.com',
          newBaseUrl: '',
          classification: 'breaking',
        },
        { kind: 'server-removed', url: 'https://staging.api.example.com', classification: 'breaking' },
      ]);
    });
  });

  describe('servers', () => {
    it('reports a server added after the first as additive, without touching baseUrl', () => {
      expect(diffServers(spec([regional]), spec([regional, staging]))).toEqual([
        { kind: 'server-added', url: 'https://staging.api.example.com', classification: 'additive' },
      ]);
    });

    it('reports a server removed after the first as breaking, without touching baseUrl', () => {
      expect(diffServers(spec([regional, staging]), spec([regional]))).toEqual([
        { kind: 'server-removed', url: 'https://staging.api.example.com', classification: 'breaking' },
      ]);
    });

    it('matches servers on the template as written, so a template with the same resolved host is still a change', () => {
      // Both resolve to https://eu.api.example.com; the client can no longer pick a region.
      const fixed = server('https://eu.api.example.com');
      expect(diffServers(spec([regional]), spec([fixed]))).toEqual([
        { kind: 'server-added', url: 'https://eu.api.example.com', classification: 'additive' },
        { kind: 'server-removed', url: 'https://{region}.api.example.com', classification: 'breaking' },
      ]);
    });

    it('ignores server and variable descriptions', () => {
      const described = server(
        'https://{region}.api.example.com',
        { region: { default: 'eu', enum: ['eu', 'us'], description: 'Where the account lives' } },
        'Regional API',
      );
      expect(diffServers(spec([regional]), spec([described]))).toEqual([]);
    });
  });

  describe('server variables', () => {
    const withPort = server('https://api.example.com:{port}', { port: { default: '443' } });

    it('reports a variable added as additive', () => {
      const gained = server('https://api.example.com:{port}', {
        port: { default: '443' },
        scheme: { default: 'https' },
      });
      expect(diffServers(spec([withPort]), spec([gained]))).toEqual([
        {
          kind: 'server-modified',
          url: 'https://api.example.com:{port}',
          variableChanges: [{ kind: 'variable-added', variableName: 'scheme', classification: 'additive' }],
          classification: 'additive',
        },
      ]);
    });

    it('reports a variable removed as breaking', () => {
      const bare = server('https://api.example.com:{port}');
      const changes = diffServers(spec([withPort]), spec([bare]));
      // The placeholder stays in the URL once nothing fills it, so baseUrl moves too.
      expect(changes[0]).toMatchObject({ kind: 'base-url-changed', classification: 'breaking' });
      expect(changes[1]).toEqual({
        kind: 'server-modified',
        url: 'https://api.example.com:{port}',
        variableChanges: [{ kind: 'variable-removed', variableName: 'port', classification: 'breaking' }],
        classification: 'breaking',
      });
      expect(changes).toHaveLength(2);
    });

    it('reports a changed default on a server after the first as breaking, without touching baseUrl', () => {
      const moved = server('https://{region}.api.example.com', { region: { default: 'us', enum: ['eu', 'us'] } });
      expect(diffServers(spec([staging, regional]), spec([staging, moved]))).toEqual([
        {
          kind: 'server-modified',
          url: 'https://{region}.api.example.com',
          variableChanges: [
            {
              kind: 'variable-default-changed',
              variableName: 'region',
              classification: 'breaking',
              oldDefault: 'eu',
              newDefault: 'us',
              details: "default changed from 'eu' to 'us'",
            },
          ],
          classification: 'breaking',
        },
      ]);
    });

    it('reports an enum value added as additive, carrying the value', () => {
      const wider = server('https://{region}.api.example.com', {
        region: { default: 'eu', enum: ['eu', 'us', 'ap'] },
      });
      expect(diffServers(spec([regional]), spec([wider]))).toEqual([
        {
          kind: 'server-modified',
          url: 'https://{region}.api.example.com',
          variableChanges: [
            { kind: 'variable-enum-value-added', variableName: 'region', value: 'ap', classification: 'additive' },
          ],
          classification: 'additive',
        },
      ]);
    });

    it('reports an enum value removed as breaking, carrying the value', () => {
      const narrower = server('https://{region}.api.example.com', { region: { default: 'eu', enum: ['eu'] } });
      expect(diffServers(spec([regional]), spec([narrower]))).toEqual([
        {
          kind: 'server-modified',
          url: 'https://{region}.api.example.com',
          variableChanges: [
            { kind: 'variable-enum-value-removed', variableName: 'region', value: 'us', classification: 'breaking' },
          ],
          classification: 'breaking',
        },
      ]);
    });

    it('reports an enum appearing as breaking: any value was accepted, now only the listed ones', () => {
      const open = server('https://{region}.api.example.com', { region: { default: 'eu' } });
      expect(diffServers(spec([open]), spec([regional]))).toEqual([
        {
          kind: 'server-modified',
          url: 'https://{region}.api.example.com',
          variableChanges: [
            {
              kind: 'variable-enum-added',
              variableName: 'region',
              classification: 'breaking',
              details: 'values restricted to eu, us',
            },
          ],
          classification: 'breaking',
        },
      ]);
    });

    it('reports an enum disappearing as additive: every value a caller picked still works', () => {
      const open = server('https://{region}.api.example.com', { region: { default: 'eu' } });
      expect(diffServers(spec([regional]), spec([open]))).toEqual([
        {
          kind: 'server-modified',
          url: 'https://{region}.api.example.com',
          variableChanges: [
            {
              kind: 'variable-enum-removed',
              variableName: 'region',
              classification: 'additive',
              details: 'any value accepted; was eu, us',
            },
          ],
          classification: 'additive',
        },
      ]);
    });

    it('collects every variable change of one server on one server-modified, breaking if any is', () => {
      const old = server('https://{region}.api.example.com:{port}', {
        region: { default: 'eu', enum: ['eu', 'us'] },
        port: { default: '443' },
      });
      const next = server('https://{region}.api.example.com:{port}', {
        region: { default: 'eu', enum: ['eu', 'us', 'ap'] },
        scheme: { default: 'https' },
      });
      const changes = diffServers(spec([staging, old]), spec([staging, next]));
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: 'server-modified', classification: 'breaking' });
      if (changes[0].kind === 'server-modified') {
        expect(changes[0].variableChanges.map((vc) => [vc.kind, vc.variableName])).toEqual([
          ['variable-added', 'scheme'],
          ['variable-removed', 'port'],
          ['variable-enum-value-added', 'region'],
        ]);
      }
    });

    it('compares a variable named like an Object.prototype member by its own value', () => {
      const old = server('https://api.example.com/{constructor}', { constructor: { default: 'a' } });
      const next = server('https://api.example.com/{constructor}', { constructor: { default: 'b' } });
      const changes = diffServers(spec([staging, old]), spec([staging, next]));
      expect(changes).toEqual([
        {
          kind: 'server-modified',
          url: 'https://api.example.com/{constructor}',
          variableChanges: [
            {
              kind: 'variable-default-changed',
              variableName: 'constructor',
              classification: 'breaking',
              oldDefault: 'a',
              newDefault: 'b',
              details: "default changed from 'a' to 'b'",
            },
          ],
          classification: 'breaking',
        },
      ]);
    });
  });

  describe('a template declared more than once', () => {
    const eu = server('https://{region}.api.example.com', { region: { default: 'eu', enum: ['eu', 'us', 'ap'] } });
    const ap = server('https://{region}.api.example.com', { region: { default: 'ap', enum: ['eu', 'us', 'ap'] } });

    it('reports the first of two same-template servers losing an enum value as breaking', () => {
      // A last-wins map would compare only the unchanged second entry and,
      // with the first default still `eu`, report nothing at all.
      const narrower = server('https://{region}.api.example.com', { region: { default: 'eu', enum: ['eu', 'ap'] } });
      expect(diffServers(spec([eu, ap]), spec([narrower, ap]))).toEqual([
        {
          kind: 'server-modified',
          url: 'https://{region}.api.example.com',
          variableChanges: [
            { kind: 'variable-enum-value-removed', variableName: 'region', value: 'us', classification: 'breaking' },
          ],
          classification: 'breaking',
        },
      ]);
      expect(diffSpecs(spec([eu, ap]), spec([narrower, ap])).summary.breaking).toBe(1);
    });

    it('reports a removed duplicate once', () => {
      expect(diffServers(spec([eu, eu]), spec([eu]))).toEqual([
        { kind: 'server-removed', url: 'https://{region}.api.example.com', classification: 'breaking' },
      ]);
    });

    it('reports a removed same-template server with its own variables as removed, not modified', () => {
      expect(diffServers(spec([eu, ap]), spec([eu]))).toEqual([
        { kind: 'server-removed', url: 'https://{region}.api.example.com', classification: 'breaking' },
      ]);
    });

    it('reports an added duplicate once', () => {
      expect(diffServers(spec([eu]), spec([eu, eu]))).toEqual([
        { kind: 'server-added', url: 'https://{region}.api.example.com', classification: 'additive' },
      ]);
    });

    it('reports nothing for identical duplicates', () => {
      expect(diffServers(spec([eu, eu]), spec([eu, eu]))).toEqual([]);
      expect(diffServers(spec([eu, ap]), spec([eu, ap]))).toEqual([]);
    });

    it('reports a reordered pair of same-template servers as base-url-changed only', () => {
      expect(diffServers(spec([eu, ap]), spec([ap, eu]))).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://eu.api.example.com',
          newBaseUrl: 'https://ap.api.example.com',
          classification: 'breaking',
        },
      ]);
    });

    it('pairs entries that all differ in declaration order', () => {
      const us = server('https://{region}.api.example.com', { region: { default: 'us', enum: ['eu', 'us', 'ap'] } });
      const sa = server('https://{region}.api.example.com', { region: { default: 'sa', enum: ['eu', 'us', 'ap'] } });
      const changes = diffServers(spec([staging, eu, ap]), spec([staging, us, sa]));
      expect(changes).toHaveLength(2);
      expect(changes.map((c) => (c.kind === 'server-modified' ? c.variableChanges[0].details : c.kind))).toEqual([
        "default changed from 'eu' to 'us'",
        "default changed from 'ap' to 'sa'",
      ]);
    });

    it("pairs same-template servers by their defaults when both changed and the list was reordered (the issue author's example)", () => {
      const url = 'https://{region}.api.example.com';
      const old = [
        server(url, { region: { default: 'eu', enum: ['eu', 'us'] } }),
        server(url, { region: { default: 'ap', enum: ['ap', 'us'] } }),
      ];
      const next = [
        server(url, { region: { default: 'ap', enum: ['ap'] } }),
        server(url, { region: { default: 'eu', enum: ['eu'] } }),
      ];
      // Pairing by position would describe this as two default swaps, each
      // with enum values added and removed; each server in fact lost `us`.
      const lostUs = {
        kind: 'server-modified',
        url,
        variableChanges: [
          { kind: 'variable-enum-value-removed', variableName: 'region', value: 'us', classification: 'breaking' },
        ],
        classification: 'breaking',
      };
      expect(diffServers(spec(old), spec(next))).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://eu.api.example.com',
          newBaseUrl: 'https://ap.api.example.com',
          classification: 'breaking',
        },
        lostUs,
        lostUs,
      ]);
    });

    it('reports a default changed on both same-template servers, in place, as two default changes', () => {
      const url = 'https://{region}.api.example.com';
      const old = [
        staging,
        server(url, { region: { default: 'eu', enum: ['eu', 'us'] } }),
        server(url, { region: { default: 'ap', enum: ['ap', 'us'] } }),
      ];
      const next = [
        staging,
        server(url, { region: { default: 'us', enum: ['eu', 'us'] } }),
        server(url, { region: { default: 'sa', enum: ['ap', 'us'] } }),
      ];
      const changes = diffServers(spec(old), spec(next));
      expect(changes).toHaveLength(2);
      expect(changes.map((c) => (c.kind === 'server-modified' ? c.variableChanges : c.kind))).toEqual([
        [
          {
            kind: 'variable-default-changed',
            variableName: 'region',
            classification: 'breaking',
            oldDefault: 'eu',
            newDefault: 'us',
            details: "default changed from 'eu' to 'us'",
          },
        ],
        [
          {
            kind: 'variable-default-changed',
            variableName: 'region',
            classification: 'breaking',
            oldDefault: 'ap',
            newDefault: 'sa',
            details: "default changed from 'ap' to 'sa'",
          },
        ],
      ]);
    });

    it('pairs same-template servers by their resolved URL when they differ only in a variable the template does not use', () => {
      const url = 'https://{region}.api.example.com';
      const old = [
        staging,
        server(url, { region: { default: 'eu' }, port: { default: '443' } }),
        server(url, { region: { default: 'ap' }, port: { default: '443' } }),
      ];
      const next = [
        staging,
        server(url, { region: { default: 'ap' }, port: { default: '8443' } }),
        server(url, { region: { default: 'eu' }, port: { default: '9443' } }),
      ];
      // No entry keeps all its defaults (port moved everywhere), so the resolved
      // URL — eu or ap — pairs them; each reports its port, not a region swap,
      // in the new document's order. The template never references {port}, so
      // neither change moves a resolved URL: additive (#292).
      const changes = diffServers(spec(old), spec(next));
      expect(changes.map((c) => (c.kind === 'server-modified' ? c.variableChanges : c.kind))).toEqual([
        [
          {
            kind: 'variable-default-changed',
            variableName: 'port',
            classification: 'additive',
            oldDefault: '443',
            newDefault: '8443',
            details:
              "default changed from '443' to '8443'; {port} is not in the URL template, so no resolved URL moves",
          },
        ],
        [
          {
            kind: 'variable-default-changed',
            variableName: 'port',
            classification: 'additive',
            oldDefault: '443',
            newDefault: '9443',
            details:
              "default changed from '443' to '9443'; {port} is not in the URL template, so no resolved URL moves",
          },
        ],
      ]);
      expect(changes.map((c) => c.classification)).toEqual(['additive', 'additive']);
    });
  });
});

describe('diffSpecs — servers', () => {
  it('lists server changes before model, enum and service changes', () => {
    const old = spec([regional]);
    const next: ApiSpec = {
      ...spec([server('https://api.example.org')]),
      models: [{ name: 'Pet', fields: [] }],
    };
    expect(diffSpecs(old, next).changes.map((c) => c.kind)).toEqual([
      'base-url-changed',
      'server-added',
      'server-removed',
      'model-added',
    ]);
  });

  it('counts base-url-changed as modified so the summary covers every change', () => {
    const diff = diffSpecs(spec([regional]), spec([server('https://api.example.org')]));
    expect(diff.summary).toEqual({ added: 1, removed: 1, modified: 1, breaking: 2, additive: 1, behaviorChanges: 0 });
    expect(diff.summary.added + diff.summary.removed + diff.summary.modified).toBe(diff.changes.length);
  });

  it('keeps an additive-only summary when a second server is added', () => {
    const diff = diffSpecs(spec([regional]), spec([regional, staging]));
    expect(diff.summary).toEqual({ added: 1, removed: 0, modified: 0, breaking: 0, additive: 1, behaviorChanges: 0 });
  });

  describe("the issue's documents (#252)", () => {
    it('reports a changed variable default as a moved baseUrl', async () => {
      const [before, after] = await Promise.all([
        parseSpec(resolve(fixtures, 'servers-before.json')),
        parseSpec(resolve(fixtures, 'servers-after.json')),
      ]);
      expect(before.baseUrl).toBe('https://eu.api.example.com');
      expect(after.baseUrl).toBe('https://us.api.example.com');

      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://eu.api.example.com',
          newBaseUrl: 'https://us.api.example.com',
          classification: 'breaking',
        },
        {
          kind: 'server-modified',
          url: 'https://{region}.api.example.com',
          variableChanges: [
            {
              kind: 'variable-default-changed',
              variableName: 'region',
              classification: 'breaking',
              oldDefault: 'eu',
              newDefault: 'us',
              details: "default changed from 'eu' to 'us'",
            },
          ],
          classification: 'breaking',
        },
      ]);
      expect(diff.summary.breaking).toBe(2);
    });

    it('reports a replaced server as a moved baseUrl plus a removal and an addition', async () => {
      const [before, moved] = await Promise.all([
        parseSpec(resolve(fixtures, 'servers-before.json')),
        parseSpec(resolve(fixtures, 'servers-moved.json')),
      ]);
      expect(moved.baseUrl).toBe('https://api.example.org');

      const diff = diffSpecs(before, moved);
      expect(diff.changes).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://eu.api.example.com',
          newBaseUrl: 'https://api.example.org',
          classification: 'breaking',
        },
        { kind: 'server-added', url: 'https://api.example.org', classification: 'additive' },
        { kind: 'server-removed', url: 'https://{region}.api.example.com', classification: 'breaking' },
      ]);
      expect(diff.summary).toEqual({ added: 1, removed: 1, modified: 1, breaking: 2, additive: 1, behaviorChanges: 0 });
    });

    it('reports nothing for the same document parsed twice', async () => {
      const [a, b] = await Promise.all([
        parseSpec(resolve(fixtures, 'servers-before.json')),
        parseSpec(resolve(fixtures, 'servers-before.json')),
      ]);
      expect(diffSpecs(a, b).changes).toEqual([]);
    });
  });
});

/**
 * OpenAPI's default server (issue #291): a document with no `servers`, with
 * `servers: []`, and with `servers: [{ url: '/' }]` all mean a single server
 * at `/`, so none of them differs from another.
 */
describe("diffServers — OpenAPI's default server (issue #291)", () => {
  const root = server('/');
  const described = server('/', undefined, 'Same origin');

  it('reports nothing between a document without servers and one that writes `/` out, either way round', () => {
    expect(diffServers(spec(), spec([root]))).toEqual([]);
    expect(diffServers(spec([root]), spec())).toEqual([]);
  });

  it('reports nothing between `servers: []` and `/` written out, either way round', () => {
    expect(diffServers(spec([]), spec([root]))).toEqual([]);
    expect(diffServers(spec([root]), spec([]))).toEqual([]);
  });

  it('ignores a description on the `/` entry, as on any server', () => {
    expect(diffServers(spec(), spec([described]))).toEqual([]);
    expect(diffServers(spec([described]), spec())).toEqual([]);
    expect(diffServers(spec([root]), spec([described]))).toEqual([]);
  });

  it('is additive when `/` written out gains a named host, with no server-removed for `/`', () => {
    expect(diffServers(spec([root]), spec([staging]))).toEqual([
      {
        kind: 'base-url-changed',
        oldBaseUrl: '/',
        newBaseUrl: 'https://staging.api.example.com',
        classification: 'additive',
      },
      { kind: 'server-added', url: 'https://staging.api.example.com', classification: 'additive' },
    ]);
  });

  it('is breaking when a named host gives way to `/` written out, with no server-added for `/`', () => {
    expect(diffServers(spec([staging]), spec([root]))).toEqual([
      {
        kind: 'base-url-changed',
        oldBaseUrl: 'https://staging.api.example.com',
        newBaseUrl: '/',
        classification: 'breaking',
      },
      { kind: 'server-removed', url: 'https://staging.api.example.com', classification: 'breaking' },
    ]);
  });

  describe('`/` beside another server (Greptile, round 2)', () => {
    const extra = server('https://extra.example');

    it('reports only the server added when `/` gains a named host beside it: the address `/` has not moved', () => {
      expect(diffServers(spec([root]), spec([root, extra]))).toEqual([
        { kind: 'server-added', url: 'https://extra.example', classification: 'additive' },
      ]);
      expect(diffSpecs(spec([root]), spec([root, extra])).summary).toEqual({
        added: 1,
        removed: 0,
        modified: 0,
        breaking: 0,
        additive: 1,
        behaviorChanges: 0,
      });
    });

    it('reports only the server removed when `/` loses the named host beside it', () => {
      expect(diffServers(spec([root, extra]), spec([root]))).toEqual([
        { kind: 'server-removed', url: 'https://extra.example', classification: 'breaking' },
      ]);
    });

    it('reports the same against a document without servers, since that is `/` too', () => {
      expect(diffServers(spec(), spec([root, extra]))).toEqual([
        { kind: 'server-added', url: 'https://extra.example', classification: 'additive' },
      ]);
      expect(diffServers(spec([root, extra]), spec())).toEqual([
        { kind: 'server-removed', url: 'https://extra.example', classification: 'breaking' },
      ]);
    });

    it('never reports `/` itself as added or removed, in either position', () => {
      expect(diffServers(spec([root, staging]), spec([staging]))).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: '/',
          newBaseUrl: 'https://staging.api.example.com',
          classification: 'additive',
        },
      ]);
      expect(diffServers(spec([staging, root]), spec([staging]))).toEqual([]);
      expect(diffServers(spec([staging]), spec([staging, root]))).toEqual([]);
    });

    it('treats `/` written out twice as the default too', () => {
      expect(diffServers(spec([root, root]), spec())).toEqual([]);
      expect(diffServers(spec([root]), spec([root, root]))).toEqual([]);
    });
  });

  it('treats `/` with a variable as the default too: `/` references no variable, so none can move it (#292)', () => {
    const rootWithPort = server('/', { port: { default: '443' } });
    expect(diffServers(spec([rootWithPort]), spec())).toEqual([]);
    expect(diffServers(spec(), spec([rootWithPort]))).toEqual([]);
    expect(diffServers(spec([root]), spec([rootWithPort]))).toEqual([]);
    // Beside a named host it is left out of the matching like any `/` entry.
    expect(diffServers(spec([rootWithPort, staging]), spec([staging]))).toEqual([
      {
        kind: 'base-url-changed',
        oldBaseUrl: '/',
        newBaseUrl: 'https://staging.api.example.com',
        classification: 'additive',
      },
    ]);
  });

  it('still treats a template that merely resolves to `/` as a server of its own, at an address that has not moved', () => {
    const rootTemplate = server('{root}', { root: { default: '/' } });
    expect(diffServers(spec(), spec([rootTemplate]))).toEqual([
      { kind: 'server-added', url: '{root}', classification: 'additive' },
    ]);
    expect(diffServers(spec([rootTemplate]), spec([root]))).toEqual([
      { kind: 'server-removed', url: '{root}', classification: 'breaking' },
    ]);
  });

  describe('a host set in `baseUrl` with no `servers` beside it (an IR built by hand; Greptile)', () => {
    const byHand = (baseUrl: string): ApiSpec => ({ ...spec(), baseUrl });

    it('is compared as written by diffServers, so a moved host is still breaking', () => {
      expect(diffServers(byHand('https://old.example.com'), byHand('https://new.example.com'))).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://old.example.com',
          newBaseUrl: 'https://new.example.com',
          classification: 'breaking',
        },
      ]);
    });

    it('is compared as written by diffSpecs, the public call', () => {
      const old = byHand('https://old.example.com');
      expect(diffSpecs(old, { ...old, baseUrl: 'https://new.example.com' }).changes).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://old.example.com',
          newBaseUrl: 'https://new.example.com',
          classification: 'breaking',
        },
      ]);
      expect(diffSpecs(old, old).changes).toEqual([]);
    });

    it('is a host that disappears (breaking) or appears (additive) against a document at the default', () => {
      expect(diffSpecs(byHand('https://old.example.com'), spec()).changes).toEqual([
        { kind: 'base-url-changed', oldBaseUrl: 'https://old.example.com', newBaseUrl: '', classification: 'breaking' },
      ]);
      expect(diffSpecs(byHand('https://old.example.com'), spec([server('/')])).changes).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://old.example.com',
          newBaseUrl: '/',
          classification: 'breaking',
        },
      ]);
      expect(diffSpecs(spec(), byHand('https://new.example.com')).changes).toEqual([
        { kind: 'base-url-changed', oldBaseUrl: '', newBaseUrl: 'https://new.example.com', classification: 'additive' },
      ]);
    });

    it('is still the default when the hand-built baseUrl is `/`', () => {
      expect(diffSpecs(byHand('/'), spec()).changes).toEqual([]);
      expect(diffSpecs(spec(), byHand('/')).changes).toEqual([]);
      expect(diffSpecs(byHand('/'), spec([server('/')])).changes).toEqual([]);
    });
  });

  it('still reports `/` moving to another path-only server as breaking', () => {
    expect(diffServers(spec([server('/v1')]), spec([server('/v2')]))).toEqual([
      { kind: 'base-url-changed', oldBaseUrl: '/v1', newBaseUrl: '/v2', classification: 'breaking' },
      { kind: 'server-added', url: '/v2', classification: 'additive' },
      { kind: 'server-removed', url: '/v1', classification: 'breaking' },
    ]);
  });

  describe("the issue's documents", () => {
    const empty = { added: 0, removed: 0, modified: 0, breaking: 0, additive: 0, behaviorChanges: 0 };

    it('reports no change between `servers: [{ url: "/" }]` and no `servers`, in either direction', async () => {
      const [slash, none] = await Promise.all([
        parseSpec(resolve(fixtures, 'servers-default-root.json')),
        parseSpec(resolve(fixtures, 'servers-default-none.json')),
      ]);
      // The IR carries each document as written; only the comparison reads them as one.
      expect(slash.baseUrl).toBe('/');
      expect(slash.servers).toEqual([{ url: '/' }]);
      expect(none.baseUrl).toBe('');
      expect(none.servers).toBeUndefined();

      expect(diffSpecs(slash, none).changes).toEqual([]);
      expect(diffSpecs(none, slash).changes).toEqual([]);
      expect(diffSpecs(slash, none).summary).toEqual(empty);
    });

    it('reports no change between `servers: []` and either of the other two spellings', async () => {
      const [emptyList, slash, none] = await Promise.all([
        parseSpec(resolve(fixtures, 'servers-default-empty.json')),
        parseSpec(resolve(fixtures, 'servers-default-root.json')),
        parseSpec(resolve(fixtures, 'servers-default-none.json')),
      ]);
      expect(emptyList.baseUrl).toBe('');
      expect(emptyList.servers).toBeUndefined();

      expect(diffSpecs(emptyList, slash).changes).toEqual([]);
      expect(diffSpecs(slash, emptyList).changes).toEqual([]);
      expect(diffSpecs(emptyList, none).changes).toEqual([]);
      expect(diffSpecs(none, emptyList).changes).toEqual([]);
    });
  });
});
