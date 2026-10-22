import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { diffServers } from '../../src/differ/servers.js';
import { diffOperations } from '../../src/differ/operations.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import { resolveServerUrl } from '../../src/ir/server-url.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, Operation, ServerEntry, ServerVariable } from '../../src/ir/types.js';

/**
 * Covers issue #292: a server variable the `url` template never references
 * cannot reach any resolved URL, so a change to it is additive whatever its
 * kind. The four kinds that are breaking for a referenced variable
 * (`variable-removed`, `variable-default-changed`, `variable-enum-added`,
 * `variable-enum-value-removed`) come out additive, each with `details`
 * saying why; the template is read by `serverUrlPlaceholders`. The other
 * server tests live in test/differ/servers.test.ts.
 */
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

function server(url: string, variables?: Record<string, ServerVariable>): ServerEntry {
  return { url, ...(variables && { variables }) };
}

/** The `details` suffix every additive-because-unreferenced change carries. */
const reason = (name: string): string => `{${name}} is not in the URL template, so no resolved URL moves`;

describe('diffServers – a variable the template never references (#292)', () => {
  const url = 'https://pets.example.com';

  describe("the issue's documents", () => {
    it('reports the changed default and the removed variable as additive, with baseUrl where it was', async () => {
      const [before, after] = await Promise.all([
        parseSpec(resolve(fixtures, 'servers-unused-variable-before.json')),
        parseSpec(resolve(fixtures, 'servers-unused-variable-after.json')),
      ]);
      expect(before.baseUrl).toBe('https://pets.example.com');
      expect(after.baseUrl).toBe('https://pets.example.com');

      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        {
          kind: 'server-modified',
          url: 'https://pets.example.com',
          variableChanges: [
            {
              kind: 'variable-removed',
              variableName: 'version',
              classification: 'additive',
              details: reason('version'),
            },
            {
              kind: 'variable-default-changed',
              variableName: 'port',
              classification: 'additive',
              oldDefault: '443',
              newDefault: '8443',
              details: `default changed from '443' to '8443'; ${reason('port')}`,
            },
          ],
          classification: 'additive',
        },
      ]);
      // `oagen diff` exits 1, not 2.
      expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 0 });
    });
  });

  describe('each kind that is breaking for a referenced variable', () => {
    it('variable-removed is additive', () => {
      const changes = diffServers(spec([server(url, { version: { default: 'v1' } })]), spec([server(url)]));
      expect(changes).toEqual([
        {
          kind: 'server-modified',
          url,
          variableChanges: [
            {
              kind: 'variable-removed',
              variableName: 'version',
              classification: 'additive',
              details: reason('version'),
            },
          ],
          classification: 'additive',
        },
      ]);
    });

    it('variable-default-changed is additive and keeps the old and new defaults', () => {
      const changes = diffServers(
        spec([server(url, { port: { default: '443' } })]),
        spec([server(url, { port: { default: '8443' } })]),
      );
      expect(changes).toEqual([
        {
          kind: 'server-modified',
          url,
          variableChanges: [
            {
              kind: 'variable-default-changed',
              variableName: 'port',
              classification: 'additive',
              oldDefault: '443',
              newDefault: '8443',
              details: `default changed from '443' to '8443'; ${reason('port')}`,
            },
          ],
          classification: 'additive',
        },
      ]);
    });

    it('variable-enum-added is additive and keeps the restricted values in details', () => {
      const changes = diffServers(
        spec([server(url, { port: { default: '443' } })]),
        spec([server(url, { port: { default: '443', enum: ['443', '8443'] } })]),
      );
      expect(changes).toEqual([
        {
          kind: 'server-modified',
          url,
          variableChanges: [
            {
              kind: 'variable-enum-added',
              variableName: 'port',
              classification: 'additive',
              details: `values restricted to 443, 8443; ${reason('port')}`,
            },
          ],
          classification: 'additive',
        },
      ]);
    });

    it('variable-enum-value-removed is additive and carries the value', () => {
      const changes = diffServers(
        spec([server(url, { port: { default: '443', enum: ['443', '8443'] } })]),
        spec([server(url, { port: { default: '443', enum: ['443'] } })]),
      );
      expect(changes).toEqual([
        {
          kind: 'server-modified',
          url,
          variableChanges: [
            {
              kind: 'variable-enum-value-removed',
              variableName: 'port',
              value: '8443',
              classification: 'additive',
              details: reason('port'),
            },
          ],
          classification: 'additive',
        },
      ]);
    });

    it('collects every kind on one additive server-modified, and no base-url-changed', () => {
      const old = server(url, { port: { default: '443', enum: ['443', '8443'] }, version: { default: 'v1' } });
      const next = server(url, { port: { default: '8443', enum: ['8443'] } });
      const changes = diffServers(spec([old]), spec([next]));
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: 'server-modified', classification: 'additive' });
      if (changes[0].kind === 'server-modified') {
        expect(changes[0].variableChanges.map((vc) => [vc.kind, vc.variableName, vc.classification])).toEqual([
          ['variable-removed', 'version', 'additive'],
          ['variable-default-changed', 'port', 'additive'],
          ['variable-enum-value-removed', 'port', 'additive'],
        ]);
      }
    });
  });

  describe('the kinds that are additive for any variable', () => {
    it('keep their shape: no reason is appended', () => {
      const changes = diffServers(
        spec([server(url, { port: { default: '443', enum: ['443'] } })]),
        spec([server(url, { port: { default: '443', enum: ['443', '8443'] }, version: { default: 'v1' } })]),
      );
      expect(changes).toEqual([
        {
          kind: 'server-modified',
          url,
          variableChanges: [
            { kind: 'variable-added', variableName: 'version', classification: 'additive' },
            { kind: 'variable-enum-value-added', variableName: 'port', value: '8443', classification: 'additive' },
          ],
          classification: 'additive',
        },
      ]);

      const lifted = diffServers(
        spec([server(url, { port: { default: '443', enum: ['443'] } })]),
        spec([server(url, { port: { default: '443' } })]),
      );
      expect(lifted).toEqual([
        {
          kind: 'server-modified',
          url,
          variableChanges: [
            {
              kind: 'variable-enum-removed',
              variableName: 'port',
              classification: 'additive',
              details: 'any value accepted; was 443',
            },
          ],
          classification: 'additive',
        },
      ]);
    });
  });

  describe('the template decides, not the variable', () => {
    it('keeps a referenced variable breaking beside an unreferenced one on the same server', () => {
      const regional = 'https://{region}.pets.example.com';
      const old = server(regional, { region: { default: 'eu' }, port: { default: '443' } });
      const next = server(regional, { region: { default: 'us' }, port: { default: '8443' } });
      expect(diffServers(spec([old]), spec([next]))).toEqual([
        {
          kind: 'base-url-changed',
          oldBaseUrl: 'https://eu.pets.example.com',
          newBaseUrl: 'https://us.pets.example.com',
          classification: 'breaking',
        },
        {
          kind: 'server-modified',
          url: regional,
          variableChanges: [
            {
              kind: 'variable-default-changed',
              variableName: 'region',
              classification: 'breaking',
              oldDefault: 'eu',
              newDefault: 'us',
              details: "default changed from 'eu' to 'us'",
            },
            {
              kind: 'variable-default-changed',
              variableName: 'port',
              classification: 'additive',
              oldDefault: '443',
              newDefault: '8443',
              details: `default changed from '443' to '8443'; ${reason('port')}`,
            },
          ],
          classification: 'breaking',
        },
      ]);
    });

    it('counts a placeholder anywhere in the template, the path included, and one used more than once', () => {
      const inPath = 'https://api.example.com/{version}';
      expect(
        diffServers(
          spec([server(inPath, { version: { default: 'v1' } })]),
          spec([server(inPath, { version: { default: 'v2' } })]),
        ),
      ).toMatchObject([
        { kind: 'base-url-changed', classification: 'breaking' },
        { kind: 'server-modified', variableChanges: [{ variableName: 'version', classification: 'breaking' }] },
      ]);

      const twice = 'https://{env}.example.com/{env}';
      expect(diffServers(spec([server(twice, { env: { default: 'a' } })]), spec([server(twice)]))).toMatchObject([
        { kind: 'base-url-changed', classification: 'breaking' },
        { kind: 'server-modified', variableChanges: [{ kind: 'variable-removed', classification: 'breaking' }] },
      ]);
    });

    it('reads braces the way resolveServerUrl does: an unclosed one is literal, so the variable is unreferenced', () => {
      const unclosed = 'https://api.example.com/{port';
      const changes = diffServers(
        spec([server(unclosed, { port: { default: '443' } })]),
        spec([server(unclosed, { port: { default: '8443' } })]),
      );
      expect(changes).toEqual([
        {
          kind: 'server-modified',
          url: unclosed,
          variableChanges: [
            {
              kind: 'variable-default-changed',
              variableName: 'port',
              classification: 'additive',
              oldDefault: '443',
              newDefault: '8443',
              details: `default changed from '443' to '8443'; ${reason('port')}`,
            },
          ],
          classification: 'additive',
        },
      ]);
    });

    it('looks a variable named like an Object.prototype member up by its own name', () => {
      // Own data properties, as the parser builds them.
      const variables = (defaultValue: string) =>
        Object.fromEntries([['constructor', { default: defaultValue }]]) as Record<string, ServerVariable>;
      const unreferenced = diffServers(spec([server(url, variables('a'))]), spec([server(url, variables('b'))]));
      expect(unreferenced).toMatchObject([
        {
          kind: 'server-modified',
          variableChanges: [
            {
              variableName: 'constructor',
              classification: 'additive',
              details: expect.stringContaining(reason('constructor')),
            },
          ],
          classification: 'additive',
        },
      ]);

      const templated = 'https://api.example.com/{constructor}';
      const referenced = diffServers(
        spec([server(templated, variables('a'))]),
        spec([server(templated, variables('b'))]),
      );
      expect(referenced).toMatchObject([
        { kind: 'base-url-changed', classification: 'breaking' },
        { kind: 'server-modified', variableChanges: [{ variableName: 'constructor', classification: 'breaking' }] },
      ]);
    });

    it('still pairs same-template duplicates that differ only in an unreferenced variable, each change additive', () => {
      const regional = 'https://{region}.pets.example.com';
      const old = [
        server(regional, { region: { default: 'eu' }, port: { default: '443' } }),
        server(regional, { region: { default: 'ap' }, port: { default: '443' } }),
      ];
      const next = [
        server(regional, { region: { default: 'eu' }, port: { default: '8443' } }),
        server(regional, { region: { default: 'ap' }, port: { default: '8443' } }),
      ];
      const changes = diffServers(spec(old), spec(next));
      expect(changes.map((c) => c.classification)).toEqual(['additive', 'additive']);
      expect(changes.map((c) => (c.kind === 'server-modified' ? c.variableChanges[0].details : c.kind))).toEqual([
        `default changed from '443' to '8443'; ${reason('port')}`,
        `default changed from '443' to '8443'; ${reason('port')}`,
      ]);
    });
  });
});

describe("an operation's servers – the comment on #292", () => {
  const listNotes: Operation = {
    name: 'listNotes',
    httpMethod: 'get',
    path: '/notes',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'string' },
    errors: [],
    injectIdempotencyKey: false,
  };
  const notes = (port: string): ServerEntry[] => [
    { url: 'https://notes.example.com', variables: { port: { default: port } } },
  ];

  it("flips serversChanged on the comment's documents; the flag is breaking until it can carry additive (#299)", async () => {
    const [before, after] = await Promise.all([
      parseSpec(resolve(fixtures, 'operation-servers-unused-variable-before.json')),
      parseSpec(resolve(fixtures, 'operation-servers-unused-variable-after.json')),
    ]);
    const { changes } = diffSpecs(before, after);
    expect(changes.map(({ kind, classification }) => ({ kind, classification }))).toEqual([
      { kind: 'operation-modified', classification: 'breaking' },
    ]);
    expect(changes[0]).toMatchObject({ operationName: 'listNotes', serversChanged: true });
  });

  it('flips serversChanged for a direct caller too', () => {
    const changes = diffOperations(
      'Notes',
      [{ ...listNotes, servers: notes('443') }],
      [{ ...listNotes, servers: notes('8443') }],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'operation-modified', serversChanged: true, classification: 'breaking' });
  });

  it('is additive at the document level for the same two lists, the building block #299 can read', () => {
    expect(diffServers(spec(notes('443')), spec(notes('8443')))).toEqual([
      {
        kind: 'server-modified',
        url: 'https://notes.example.com',
        variableChanges: [
          {
            kind: 'variable-default-changed',
            variableName: 'port',
            classification: 'additive',
            oldDefault: '443',
            newDefault: '8443',
            details: `default changed from '443' to '8443'; ${reason('port')}`,
          },
        ],
        classification: 'additive',
      },
    ]);
  });
});
