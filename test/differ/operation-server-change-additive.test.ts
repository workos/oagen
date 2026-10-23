import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffOperations } from '../../src/differ/operations.js';
import { diffServers } from '../../src/differ/servers.js';
import { diffSpecs } from '../../src/differ/diff.js';
import { parseSpec } from '../../src/parser/parse.js';
import { resolveServerUrl } from '../../src/ir/server-url.js';
import type { ApiSpec, Operation, ServerEntry } from '../../src/ir/types.js';
import type { Change, OperationModified, ServerChange } from '../../src/differ/types.js';

/**
 * Covers issue #299: a change to the servers an operation is served from is
 * classified change by change, as the document-level diff classifies the
 * same edit to the document's `servers` — breaking only when a server the
 * caller could use is gone or its resolved URL moved — and the
 * `operation-modified` change carries that list as `serverChanges`. Before,
 * `serversChanged` was one breaking boolean, so an enum value added, an enum
 * lifted or a variable added was additive on the document (`oagen diff` exit
 * `1`) and breaking on a Path Item or an Operation (exit `2`). What counts
 * as a change at all, and where an operation is served from, is covered in
 * test/differ/operation-servers.test.ts; the document-level rules in
 * test/differ/servers.test.ts and test/differ/unused-server-variable.test.ts.
 */
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

/** `listNotes` carrying `servers`, or inheriting (no key) when none is given. */
function withServers(servers?: ServerEntry[]): Operation {
  return servers ? { ...listNotes, servers } : listNotes;
}

/** The one `operation-modified` change between two versions of `listNotes`, compared as a direct caller. */
function modified(oldOp: Operation, newOp: Operation): OperationModified {
  const changes = diffOperations('Notes', [oldOp], [newOp]);
  expect(changes).toHaveLength(1);
  expect(changes[0].kind).toBe('operation-modified');
  return changes[0] as OperationModified;
}

/** A spec whose `baseUrl` is `servers[0]` resolved, the way the parser builds it. */
function spec(servers?: ServerEntry[]): Pick<ApiSpec, 'baseUrl' | 'servers'> {
  return { baseUrl: servers?.[0] ? resolveServerUrl(servers[0]).url : '', servers };
}

const regional = (region: { default: string; enum?: string[] }): ServerEntry => ({
  url: 'https://{region}.notes.example.com',
  variables: { region },
});
const a: ServerEntry = { url: 'https://a.example.com' };
const b: ServerEntry = { url: 'https://b.example.com' };
const c: ServerEntry = { url: 'https://c.example.com' };

describe("diffOperations – a server change's classification (issue #299)", () => {
  describe('is the classification the document-level diff gives the same edit', () => {
    const cases: Array<[string, ServerEntry[], ServerEntry[]]> = [
      [
        'an enum value added',
        [regional({ default: 'eu', enum: ['eu'] })],
        [regional({ default: 'eu', enum: ['eu', 'us'] })],
      ],
      ['an enum lifted', [regional({ default: 'eu', enum: ['eu'] })], [regional({ default: 'eu' })]],
      [
        'a variable added',
        [{ url: 'https://notes.example.com' }],
        [{ url: 'https://notes.example.com', variables: { tier: { default: 'free' } } }],
      ],
      ['an entry added after the first', [a], [a, b]],
      ['an entry removed', [a, b], [a]],
      ['the first entry moved', [a, b], [b, a]],
      ['a referenced default changed', [regional({ default: 'eu' })], [regional({ default: 'us' })]],
      [
        'an enum value removed',
        [regional({ default: 'eu', enum: ['eu', 'us'] })],
        [regional({ default: 'eu', enum: ['eu'] })],
      ],
      [
        'an enum put on a referenced variable',
        [regional({ default: 'eu' })],
        [regional({ default: 'eu', enum: ['eu'] })],
      ],
      [
        'a template changed',
        [regional({ default: 'eu' })],
        [{ url: 'https://{region}.notes.example.net', variables: { region: { default: 'eu' } } }],
      ],
      ['a host gained where there was none', [], [a]],
      ['a host lost', [a], []],
      [
        "an unreferenced variable's default changed",
        [{ url: 'https://notes.example.com', variables: { port: { default: '443' } } }],
        [{ url: 'https://notes.example.com', variables: { port: { default: '8443' } } }],
      ],
      ['one entry added beside one removed', [a, b], [a, c]],
    ];

    it.each(cases)('%s', (_label, oldServers, newServers) => {
      const documentChanges: ServerChange[] = diffServers(spec(oldServers), spec(newServers));
      expect(documentChanges.length).toBeGreaterThan(0);
      const change = modified(withServers(oldServers.length > 0 ? oldServers : undefined), withServers(newServers));
      expect(change.serversChanged).toBe(true);
      expect(change.serverChanges).toEqual(documentChanges);
      expect(change.classification).toBe(
        documentChanges.some((dc) => dc.classification === 'breaking') ? 'breaking' : 'additive',
      );
    });
  });

  describe('additive: nothing a caller could use is gone and no resolved URL moved', () => {
    it('an enum value added', () => {
      expect(
        modified(
          withServers([regional({ default: 'eu', enum: ['eu'] })]),
          withServers([regional({ default: 'eu', enum: ['eu', 'us'] })]),
        ),
      ).toMatchObject({
        serversChanged: true,
        serverChanges: [
          {
            kind: 'server-modified',
            url: 'https://{region}.notes.example.com',
            variableChanges: [
              { kind: 'variable-enum-value-added', variableName: 'region', value: 'us', classification: 'additive' },
            ],
            classification: 'additive',
          },
        ],
        classification: 'additive',
      });
    });

    it('an enum lifted', () => {
      expect(
        modified(withServers([regional({ default: 'eu', enum: ['eu'] })]), withServers([regional({ default: 'eu' })])),
      ).toMatchObject({
        serverChanges: [
          {
            kind: 'server-modified',
            variableChanges: [{ kind: 'variable-enum-removed', variableName: 'region', classification: 'additive' }],
            classification: 'additive',
          },
        ],
        classification: 'additive',
      });
    });

    it('a variable added', () => {
      expect(
        modified(
          withServers([{ url: 'https://notes.example.com' }]),
          withServers([{ url: 'https://notes.example.com', variables: { tier: { default: 'free' } } }]),
        ),
      ).toMatchObject({
        serverChanges: [
          {
            kind: 'server-modified',
            variableChanges: [{ kind: 'variable-added', variableName: 'tier', classification: 'additive' }],
            classification: 'additive',
          },
        ],
        classification: 'additive',
      });
    });

    it('an entry added after the first', () => {
      expect(modified(withServers([a]), withServers([a, b]))).toMatchObject({
        serverChanges: [{ kind: 'server-added', url: 'https://b.example.com', classification: 'additive' }],
        classification: 'additive',
      });
    });

    it('a host gained where there was none, as a document that gains its first server', () => {
      // A direct caller: inheriting is OpenAPI's default, `/`, which has no host.
      expect(modified(withServers(), withServers([a]))).toMatchObject({
        serverChanges: [
          { kind: 'base-url-changed', oldBaseUrl: '', newBaseUrl: 'https://a.example.com', classification: 'additive' },
          { kind: 'server-added', url: 'https://a.example.com', classification: 'additive' },
        ],
        classification: 'additive',
      });
      // `/` written out is the same starting point (#291).
      expect(modified(withServers([{ url: '/' }]), withServers([a]))).toMatchObject({
        serverChanges: [{ kind: 'base-url-changed', classification: 'additive' }, { kind: 'server-added' }],
        classification: 'additive',
      });
    });

    it("an unreferenced variable's default changed, with the document-level reason (#292)", () => {
      expect(
        modified(
          withServers([{ url: 'https://notes.example.com', variables: { port: { default: '443' } } }]),
          withServers([{ url: 'https://notes.example.com', variables: { port: { default: '8443' } } }]),
        ),
      ).toMatchObject({
        serverChanges: [
          {
            kind: 'server-modified',
            url: 'https://notes.example.com',
            variableChanges: [
              {
                kind: 'variable-default-changed',
                variableName: 'port',
                oldDefault: '443',
                newDefault: '8443',
                classification: 'additive',
                details:
                  "default changed from '443' to '8443'; {port} is not in the URL template, so no resolved URL moves",
              },
            ],
            classification: 'additive',
          },
        ],
        classification: 'additive',
      });
    });
  });

  describe('breaking: a server the caller could use is gone or its resolved URL moved', () => {
    it('an entry removed', () => {
      expect(modified(withServers([a, b]), withServers([a]))).toMatchObject({
        serverChanges: [{ kind: 'server-removed', url: 'https://b.example.com', classification: 'breaking' }],
        classification: 'breaking',
      });
    });

    it('the first entry moved', () => {
      expect(modified(withServers([a, b]), withServers([b, a]))).toMatchObject({
        serverChanges: [
          {
            kind: 'base-url-changed',
            oldBaseUrl: 'https://a.example.com',
            newBaseUrl: 'https://b.example.com',
            classification: 'breaking',
          },
        ],
        classification: 'breaking',
      });
    });

    it('a referenced default changed', () => {
      expect(
        modified(withServers([regional({ default: 'eu' })]), withServers([regional({ default: 'us' })])),
      ).toMatchObject({
        serverChanges: [
          {
            kind: 'base-url-changed',
            oldBaseUrl: 'https://eu.notes.example.com',
            newBaseUrl: 'https://us.notes.example.com',
            classification: 'breaking',
          },
          {
            kind: 'server-modified',
            variableChanges: [{ kind: 'variable-default-changed', variableName: 'region', classification: 'breaking' }],
            classification: 'breaking',
          },
        ],
        classification: 'breaking',
      });
    });

    it('an enum value removed, and an enum put on a referenced variable', () => {
      expect(
        modified(
          withServers([regional({ default: 'eu', enum: ['eu', 'us'] })]),
          withServers([regional({ default: 'eu', enum: ['eu'] })]),
        ),
      ).toMatchObject({
        serverChanges: [
          {
            kind: 'server-modified',
            variableChanges: [{ kind: 'variable-enum-value-removed', value: 'us', classification: 'breaking' }],
            classification: 'breaking',
          },
        ],
        classification: 'breaking',
      });
      expect(
        modified(withServers([regional({ default: 'eu' })]), withServers([regional({ default: 'eu', enum: ['eu'] })])),
      ).toMatchObject({
        serverChanges: [
          {
            kind: 'server-modified',
            variableChanges: [{ kind: 'variable-enum-added', classification: 'breaking' }],
            classification: 'breaking',
          },
        ],
        classification: 'breaking',
      });
    });

    it('a host lost', () => {
      expect(modified(withServers([a]), withServers())).toMatchObject({
        serverChanges: [
          { kind: 'base-url-changed', oldBaseUrl: 'https://a.example.com', newBaseUrl: '', classification: 'breaking' },
          { kind: 'server-removed', url: 'https://a.example.com', classification: 'breaking' },
        ],
        classification: 'breaking',
      });
    });

    it('one entry added beside one removed: the breaking entry decides', () => {
      expect(modified(withServers([a, b]), withServers([a, c]))).toMatchObject({
        serverChanges: [
          { kind: 'server-added', url: 'https://c.example.com', classification: 'additive' },
          { kind: 'server-removed', url: 'https://b.example.com', classification: 'breaking' },
        ],
        classification: 'breaking',
      });
    });
  });

  describe('composes with the other flags like every classified list', () => {
    const relaxed: Operation = {
      ...listNotes,
      queryParams: [{ name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: false }],
    };
    const tightened: Operation = {
      ...listNotes,
      queryParams: [{ name: 'limit', type: { kind: 'primitive', type: 'integer' }, required: true }],
    };
    const wider = [regional({ default: 'eu', enum: ['eu', 'us'] })];
    const narrow = [regional({ default: 'eu', enum: ['eu'] })];

    it('an additive server change beside an additive parameter change is additive', () => {
      expect(modified({ ...listNotes, servers: narrow }, { ...relaxed, servers: wider })).toMatchObject({
        serversChanged: true,
        paramChanges: [{ kind: 'param-added', classification: 'additive' }],
        classification: 'additive',
      });
    });

    it('an additive server change beside a breaking parameter change is breaking', () => {
      expect(modified({ ...listNotes, servers: narrow }, { ...tightened, servers: wider })).toMatchObject({
        serversChanged: true,
        serverChanges: [{ classification: 'additive' }],
        paramChanges: [{ kind: 'param-added', classification: 'breaking' }],
        classification: 'breaking',
      });
    });

    it('a breaking server change beside an additive parameter change is breaking', () => {
      expect(modified({ ...listNotes, servers: wider }, { ...relaxed, servers: narrow })).toMatchObject({
        serverChanges: [{ classification: 'breaking' }],
        paramChanges: [{ classification: 'additive' }],
        classification: 'breaking',
      });
    });

    it('carries an empty list on an unrelated change', () => {
      const retyped: Operation = { ...withServers([a]), response: { kind: 'model', name: 'NotePage' } };
      expect(modified(withServers([a]), retyped)).toMatchObject({
        responseChanged: true,
        serversChanged: false,
        serverChanges: [],
        classification: 'breaking',
      });
    });

    it('carries an empty list when the operation inherits a moved document on both sides', () => {
      // The document-level diff reports the document; nothing is the operation's.
      expect(diffOperations('Notes', [listNotes], [listNotes], { old: [a], new: [b] })).toEqual([]);
    });
  });
});

/**
 * The issue's repro, end to end: nine pairs of documents, each changing one
 * server declared on the document, on the Path Item or on the Operation, and
 * `diffSpecs` giving the edit the same classification at every level.
 */
describe("the issue's documents (issue #299)", () => {
  type Level = 'document' | 'path' | 'operation';
  type Edit = 'enum-lifted' | 'enum-value-added' | 'variable-added';
  const levels: Level[] = ['document', 'path', 'operation'];
  const edits: Edit[] = ['enum-lifted', 'enum-value-added', 'variable-added'];

  const regionalServer = (region: { default: string; enum?: string[] }) => ({
    url: 'https://{region}.notes.example.com',
    variables: { region },
  });
  const server = (edit: Edit, side: 'old' | 'new'): object => {
    switch (edit) {
      case 'enum-lifted':
        return side === 'old' ? regionalServer({ default: 'eu', enum: ['eu'] }) : regionalServer({ default: 'eu' });
      case 'enum-value-added':
        return side === 'old'
          ? regionalServer({ default: 'eu', enum: ['eu'] })
          : regionalServer({ default: 'eu', enum: ['eu', 'us'] });
      case 'variable-added':
        return side === 'old'
          ? { url: 'https://notes.example.com' }
          : { url: 'https://notes.example.com', variables: { tier: { default: 'free' } } };
    }
  };
  /** `GET /notes` with the server at `level`; the Path Item and the Operation sit under `https://api.example.com`. */
  const document = (level: Level, edit: Edit, side: 'old' | 'new'): object => {
    const get = { operationId: 'listNotes', responses: { '204': { description: 'ok' } } };
    const base = { openapi: '3.1.0', info: { title: 'repro', version: '1' } };
    const entry = server(edit, side);
    if (level === 'document') return { ...base, servers: [entry], paths: { '/notes': { get } } };
    const servers = [{ url: 'https://api.example.com' }];
    if (level === 'path') return { ...base, servers, paths: { '/notes': { servers: [entry], get } } };
    return { ...base, servers, paths: { '/notes': { get: { ...get, servers: [entry] } } } };
  };

  let tmpDir: string;
  const specs = {} as Record<Level, Record<Edit, { old: ApiSpec; new: ApiSpec }>>;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-diff-299-'));
    for (const level of levels) {
      specs[level] = {} as Record<Edit, { old: ApiSpec; new: ApiSpec }>;
      for (const edit of edits) {
        const file = async (side: 'old' | 'new'): Promise<ApiSpec> => {
          const name = path.join(tmpDir, `${level}-${edit}-${side}.json`);
          await fs.writeFile(name, JSON.stringify(document(level, edit, side), null, 2), 'utf-8');
          return parseSpec(name);
        };
        specs[level][edit] = { old: await file('old'), new: await file('new') };
      }
    }
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const line = (changes: Change[]): string =>
    changes
      .map((ch) =>
        ch.kind === 'operation-modified'
          ? `serversChanged: ${ch.serversChanged}, ${ch.classification}`
          : `${ch.kind}, ${ch.classification}`,
      )
      .join('; ');

  it("prints the issue's table with every row additive", () => {
    const lines: string[] = [];
    for (const level of levels) {
      for (const edit of edits) {
        const { old, new: next } = specs[level][edit];
        lines.push(`${level} ${edit}: ${line(diffSpecs(old, next).changes)}`);
      }
    }
    expect(lines).toEqual([
      'document enum-lifted: server-modified, additive',
      'document enum-value-added: server-modified, additive',
      'document variable-added: server-modified, additive',
      'path enum-lifted: serversChanged: true, additive',
      'path enum-value-added: serversChanged: true, additive',
      'path variable-added: serversChanged: true, additive',
      'operation enum-lifted: serversChanged: true, additive',
      'operation enum-value-added: serversChanged: true, additive',
      'operation variable-added: serversChanged: true, additive',
    ]);
  });

  it.each(edits)(
    '%s: the operation carries the very change the document reports, and the summary counts it additive',
    (edit) => {
      const { old, new: next } = specs.document[edit];
      const documentReport = diffSpecs(old, next);
      expect(documentReport.changes).toHaveLength(1);
      expect(documentReport.summary).toMatchObject({ modified: 1, breaking: 0, additive: 1 });

      for (const level of ['path', 'operation'] as const) {
        const report = diffSpecs(specs[level][edit].old, specs[level][edit].new);
        expect(report.changes, level).toHaveLength(1);
        expect(report.changes[0], level).toMatchObject({
          kind: 'operation-modified',
          operationName: 'listNotes',
          serversChanged: true,
          serverChanges: documentReport.changes,
          classification: 'additive',
        });
        // What `oagen diff` exits on: `1` here, as for the document.
        expect(report.summary, level).toMatchObject({ modified: 1, breaking: 0, additive: 1 });
      }
    },
  );

  it('is still breaking at every level when the resolved URL moves', async () => {
    // The same three documents with `region`'s default moved, so the only
    // difference from the additive rows is the kind of edit.
    const moved = async (level: Level): Promise<[ApiSpec, ApiSpec]> => {
      const write = async (side: 'old' | 'new', region: string): Promise<ApiSpec> => {
        const doc = JSON.parse(JSON.stringify(document(level, 'enum-lifted', 'new')));
        const list =
          level === 'document'
            ? doc.servers
            : level === 'path'
              ? doc.paths['/notes'].servers
              : doc.paths['/notes'].get.servers;
        list[0].variables.region.default = region;
        const name = path.join(tmpDir, `${level}-default-moved-${side}.json`);
        await fs.writeFile(name, JSON.stringify(doc), 'utf-8');
        return parseSpec(name);
      };
      return [await write('old', 'eu'), await write('new', 'us')];
    };
    const [docOld, docNew] = await moved('document');
    const documentReport = diffSpecs(docOld, docNew);
    expect(documentReport.changes.map((ch) => [ch.kind, ch.classification])).toEqual([
      ['base-url-changed', 'breaking'],
      ['server-modified', 'breaking'],
    ]);
    for (const level of ['path', 'operation'] as const) {
      const [oldSpec, newSpec] = await moved(level);
      const report = diffSpecs(oldSpec, newSpec);
      expect(report.changes, level).toHaveLength(1);
      expect(report.changes[0], level).toMatchObject({
        kind: 'operation-modified',
        serversChanged: true,
        serverChanges: documentReport.changes,
        classification: 'breaking',
      });
      expect(report.summary, level).toMatchObject({ breaking: 1, additive: 0 });
    }
  });

  it('has nothing to classify on a webhook: the IR carries no servers for one', async () => {
    // A webhook's Path Item may declare `servers`, but `Webhook` has no such
    // field, so two documents that differ only there differ in nothing the
    // differ compares.
    const webhookDocument = (url: string): object => ({
      openapi: '3.1.0',
      info: { title: 'repro', version: '1' },
      webhooks: {
        noteCreated: {
          servers: [{ url }],
          post: {
            operationId: 'noteCreated',
            requestBody: {
              content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    const write = async (name: string, url: string): Promise<ApiSpec> => {
      const file = path.join(tmpDir, name);
      await fs.writeFile(file, JSON.stringify(webhookDocument(url)), 'utf-8');
      return parseSpec(file);
    };
    const [before, after] = await Promise.all([
      write('webhook-servers-old.json', 'https://hooks.example.com'),
      write('webhook-servers-new.json', 'https://hooks.example.net'),
    ]);
    expect(before.webhooks).toHaveLength(1);
    expect(before.webhooks?.[0]).not.toHaveProperty('servers');
    expect(diffSpecs(before, after).changes).toEqual([]);
  });
});

/**
 * The `documentServers` fallback in `diffOperations` with an additive result
 * (#349 review): the operation inherits on one side and declares its own
 * list on the other, and what it is served from gains an entry. The other
 * tests reach that fallback only where the result is breaking or nothing.
 */
describe('inheriting on one side, additive (#349 review)', () => {
  const added = [{ kind: 'server-added', url: 'https://b.example.com', classification: 'additive' }];

  it('an operation under a document at `a` that starts declaring `[a, b]`', () => {
    const changes = diffOperations('Notes', [listNotes], [withServers([a, b])], { old: [a], new: [a] });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'operation-modified',
      operationName: 'listNotes',
      serversChanged: true,
      serverChanges: added,
      classification: 'additive',
    });
  });

  it('an operation whose `[a]` override disappears because the document moved to `[a, b]`', () => {
    // From a document without servers, and from one at another host: the
    // operation's `serverChanges` are its own effective lists' alone, `[a]`
    // → `[a, b]`; what the document itself did is the document-level diff's.
    for (const oldDocument of [undefined, [c]]) {
      const changes = diffOperations('Notes', [withServers([a])], [listNotes], { old: oldDocument, new: [a, b] });
      expect(changes, oldDocument ? 'from another host' : 'from no server').toHaveLength(1);
      expect(changes[0]).toMatchObject({
        kind: 'operation-modified',
        serversChanged: true,
        serverChanges: added,
        classification: 'additive',
      });
    }
  });
});
