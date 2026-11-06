/**
 * Issue #384: `diffSpecs` compares the security scheme definitions under
 * `components.securitySchemes` (`ApiSpec.auth`) by `schemeName`.
 *
 * A requirement names a scheme; the definition says what a request carrying
 * it puts on the wire. A scheme added is additive; one removed is breaking
 * when some request read it (in use in the old document, or still named in
 * the new) and additive otherwise; one modified in anything but
 * `description` is breaking when its wire form (`kind`; an `apiKey`'s `in`
 * and `name`; `oauth2` `flows` without each flow's `scopes`) changed and the
 * scheme is in use in the new document, additive otherwise. "In use" is
 * named by the effective requirement list (`node.security ?? spec.security
 * ?? []`) of some operation or webhook, so a document default counts only
 * through a node that inherits it. Every scheme change is mirrored into
 * `behaviorChanges` as `security-scheme-changed`.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffAuthSchemes, schemesInUse, scopesInUse } from '../../src/differ/auth.js';
import { diffCommand } from '../../src/cli/diff.js';
import type {
  SecuritySchemeAdded,
  SecuritySchemeChange,
  SecuritySchemeChanged,
  SecuritySchemeModified,
  SecuritySchemeRemoved,
} from '../../src/index.js';
import type { DiffReport } from '../../src/differ/types.js';
import { parseSpec } from '../../src/parser/parse.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, AuthScheme, Operation, SecurityRequirementSet, Webhook } from '../../src/ir/types.js';

// ---------------------------------------------------------------------------
// Documents written to files, as `oagen diff` reads them.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

let written = 0;
async function write(doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-diff-security-schemes-'));
  dirs.push(dir);
  const file = path.join(dir, `${written++}.json`);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

/** The scheme objects the issue's documents declare, as written in OpenAPI. */
const xKey = { type: 'apiKey', in: 'header', name: 'X-Key' };
const xApiKey = { type: 'apiKey', in: 'header', name: 'X-Api-Key' };
const xKeyQuery = { type: 'apiKey', in: 'query', name: 'X-Key' };
const basic = { type: 'http', scheme: 'basic' };
const bearer = { type: 'http', scheme: 'bearer' };
const oauth2 = (flows: Record<string, unknown>) => ({ type: 'oauth2', flows });
const clientCredentials = (overrides: Record<string, unknown> = {}) => ({
  tokenUrl: 'https://auth.example.com/token',
  scopes: { 'pets:read': 'Read pets' },
  ...overrides,
});

/** The same schemes as the parser reads them. */
const xKeyScheme: AuthScheme = { kind: 'apiKey', schemeName: 'apiKey', in: 'header', name: 'X-Key' };
const xApiKeyScheme: AuthScheme = { kind: 'apiKey', schemeName: 'apiKey', in: 'header', name: 'X-Api-Key' };
const xKeyQueryScheme: AuthScheme = { kind: 'apiKey', schemeName: 'apiKey', in: 'query', name: 'X-Key' };
const basicScheme: AuthScheme = { kind: 'basic', schemeName: 'apiKey' };
const bearerScheme: AuthScheme = { kind: 'bearer', schemeName: 'bearer' };

const ok = { responses: { '204': { description: 'ok' } } };
/** `GET /pets`, with the given `security` when one is passed. */
function listPetsPath(security?: unknown[]) {
  return { '/pets': { get: { operationId: 'listPets', ...(security ? { security } : {}), ...ok } } };
}

interface Doc {
  securitySchemes?: Record<string, unknown>;
  security?: unknown[];
  paths?: Record<string, unknown>;
  webhooks?: Record<string, unknown>;
  schemas?: Record<string, unknown>;
}

function document(openapi: string, doc: Doc) {
  const components = {
    ...(doc.securitySchemes ? { securitySchemes: doc.securitySchemes } : {}),
    ...(doc.schemas ? { schemas: doc.schemas } : {}),
  };
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    ...(doc.security !== undefined ? { security: doc.security } : {}),
    ...(Object.keys(components).length > 0 ? { components } : {}),
    paths: doc.paths ?? listPetsPath(),
    ...(doc.webhooks ? { webhooks: doc.webhooks } : {}),
  };
}

/** The exit code `oagen diff` gives a report: 2 breaking, 1 any other change, 0 none. */
function exitCode(report: DiffReport): 0 | 1 | 2 {
  const { breaking, modified, removed, added } = report.summary;
  return breaking > 0 ? 2 : modified > 0 || removed > 0 || added > 0 ? 1 : 0;
}

/** The one `security-scheme-modified` change a report carries, and nothing else. */
function onlyModified(report: DiffReport): SecuritySchemeModified {
  expect(report.changes).toHaveLength(1);
  const change = report.changes[0];
  expect(change.kind).toBe('security-scheme-modified');
  return change as SecuritySchemeModified;
}

describe.each(['3.0.3', '3.1.0'])('#384 on OAS %s', (openapi) => {
  const doc = (d: Doc) => document(openapi, d);
  const parse = async (d: Doc): Promise<ApiSpec> => parseSpec(await write(doc(d)));
  /** The issue's `old.json`: `GET /pets` under a document default that names `apiKey`. */
  const issueOld = (): Doc => ({ security: [{ apiKey: [] }], securitySchemes: { apiKey: xKey } });

  describe('the issue’s documents: a scheme every request carries, edited under the same name', () => {
    const cases: Array<[string, Record<string, unknown>, AuthScheme, string, string]> = [
      [
        'new.json: the header name',
        xApiKey,
        xApiKeyScheme,
        'apiKey in header "X-Key" → in header "X-Api-Key"',
        'apiKey in header "X-Api-Key" → in header "X-Key"',
      ],
      [
        'query.json: the location',
        xKeyQuery,
        xKeyQueryScheme,
        'apiKey in header "X-Key" → in query "X-Key"',
        'apiKey in query "X-Key" → in header "X-Key"',
      ],
      ['basic.json: the kind', basic, basicScheme, 'apiKey → http basic', 'http basic → apiKey'],
    ];

    it.each(cases)(
      '%s: one breaking security-scheme-modified, mirrored, exit 2',
      async (_label, scheme, parsed, details, back) => {
        const before = await parse(issueOld());
        const after = await parse({ security: [{ apiKey: [] }], securitySchemes: { apiKey: scheme } });
        expect(before.auth).toEqual([xKeyScheme]);
        expect(after.auth).toEqual([parsed]);

        const diff = diffSpecs(before, after);
        expect(diff.changes).toEqual([
          {
            kind: 'security-scheme-modified',
            schemeName: 'apiKey',
            oldScheme: xKeyScheme,
            newScheme: parsed,
            details,
            classification: 'breaking',
          },
        ]);
        expect(diff.behaviorChanges).toEqual([
          {
            kind: 'security-scheme-changed',
            schemeName: 'apiKey',
            oldScheme: xKeyScheme,
            newScheme: parsed,
            classification: 'breaking',
          },
        ]);
        expect(diff.summary).toEqual({
          added: 0,
          removed: 0,
          modified: 1,
          breaking: 1,
          additive: 0,
          behaviorChanges: 1,
        });
        expect(exitCode(diff)).toBe(2);

        // The other way round the old form is the edited one; still breaking.
        const reverse = diffSpecs(after, before);
        expect(reverse.changes).toEqual([
          {
            kind: 'security-scheme-modified',
            schemeName: 'apiKey',
            oldScheme: parsed,
            newScheme: xKeyScheme,
            details: back,
            classification: 'breaking',
          },
        ]);
        expect(reverse.behaviorChanges).toEqual([
          {
            kind: 'security-scheme-changed',
            schemeName: 'apiKey',
            oldScheme: parsed,
            newScheme: xKeyScheme,
            classification: 'breaking',
          },
        ]);
        expect(exitCode(reverse)).toBe(2);
      },
    );

    describe('through diffCommand', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it.each(cases)('%s exits 2 and prints the change', async (_label, scheme) => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const old = await write(doc(issueOld()));
        const next = await write(doc({ security: [{ apiKey: [] }], securitySchemes: { apiKey: scheme } }));
        const err: unknown = await diffCommand({ old, new: next }).catch((e: unknown) => e);
        expect(err).toMatchObject({ exitCode: 2 });
        const printed = JSON.parse(log.mock.calls[0][0] as string) as DiffReport;
        expect(printed.changes.map((c) => c.kind)).toEqual(['security-scheme-modified']);
        expect(printed.summary.breaking).toBe(1);
      });
    });

    it('reports nothing when the same document is parsed twice, exit 0', async () => {
      const a = await parse(issueOld());
      const b = await parse(issueOld());
      const diff = diffSpecs(a, b);
      expect(diff.changes).toEqual([]);
      expect(diff.behaviorChanges).toEqual([]);
      expect(exitCode(diff)).toBe(0);
    });
  });

  describe('the same edits on a scheme nothing uses are additive, exit 1', () => {
    const edits: Array<[string, Record<string, unknown>, AuthScheme]> = [
      ['the header name', xApiKey, xApiKeyScheme],
      ['the location', xKeyQuery, xKeyQueryScheme],
      ['the kind', basic, basicScheme],
    ];

    it.each(edits)('%s, when the document default names another scheme', async (_label, scheme, parsed) => {
      // `apiKey` is declared on both sides but every request carries `bearer`.
      const before = await parse({ security: [{ bearer: [] }], securitySchemes: { apiKey: xKey, bearer } });
      const after = await parse({ security: [{ bearer: [] }], securitySchemes: { apiKey: scheme, bearer } });
      const diff = diffSpecs(before, after);
      expect(onlyModified(diff)).toMatchObject({
        schemeName: 'apiKey',
        oldScheme: xKeyScheme,
        newScheme: parsed,
        classification: 'additive',
      });
      expect(diff.behaviorChanges).toEqual([
        {
          kind: 'security-scheme-changed',
          schemeName: 'apiKey',
          oldScheme: xKeyScheme,
          newScheme: parsed,
          classification: 'additive',
        },
      ]);
      expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 1 });
      expect(exitCode(diff)).toBe(1);
      expect(onlyModified(diffSpecs(after, before))).toMatchObject({ classification: 'additive' });
    });

    it.each(edits)('%s, when every operation declares `security: []`', async (_label, scheme) => {
      const before = await parse({
        security: [{ apiKey: [] }],
        securitySchemes: { apiKey: xKey },
        paths: listPetsPath([]),
      });
      const after = await parse({
        security: [{ apiKey: [] }],
        securitySchemes: { apiKey: scheme },
        paths: listPetsPath([]),
      });
      expect(onlyModified(diffSpecs(before, after))).toMatchObject({
        schemeName: 'apiKey',
        classification: 'additive',
      });
      expect(onlyModified(diffSpecs(after, before))).toMatchObject({
        schemeName: 'apiKey',
        classification: 'additive',
      });
      expect(exitCode(diffSpecs(before, after))).toBe(1);
    });
  });

  it('a description-only edit is no change, exit 0', async () => {
    const before = await parse({
      security: [{ apiKey: [] }],
      securitySchemes: { apiKey: { ...xKey, description: 'The key' } },
    });
    const after = await parse({
      security: [{ apiKey: [] }],
      securitySchemes: { apiKey: { ...xKey, description: 'Your API key' } },
    });
    expect(before.auth?.[0].description).toBe('The key');
    expect(after.auth?.[0].description).toBe('Your API key');
    for (const diff of [diffSpecs(before, after), diffSpecs(after, before)]) {
      expect(diff.changes).toEqual([]);
      expect(diff.behaviorChanges).toEqual([]);
      expect(exitCode(diff)).toBe(0);
    }
    // A description appearing or disappearing is documentation too.
    const bare = await parse({ security: [{ apiKey: [] }], securitySchemes: { apiKey: xKey } });
    expect(diffSpecs(before, bare).changes).toEqual([]);
    expect(diffSpecs(bare, before).changes).toEqual([]);
  });

  describe('oauth2: the flows are the wire form, their scopes are not', () => {
    const inUse = (flows: Record<string, unknown>): Doc => ({
      security: [{ oauth: ['pets:read'] }],
      securitySchemes: { oauth: oauth2(flows) },
    });
    const parsedOauth = (flows: Record<string, unknown>): AuthScheme => ({
      kind: 'oauth2',
      schemeName: 'oauth',
      flows,
    });

    it('a changed tokenUrl on a scheme in use is breaking, `oauth2 flows changed`', async () => {
      const oldFlows = { clientCredentials: clientCredentials() };
      const newFlows = { clientCredentials: clientCredentials({ tokenUrl: 'https://auth.example.com/v2/token' }) };
      const before = await parse(inUse(oldFlows));
      const after = await parse(inUse(newFlows));
      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        {
          kind: 'security-scheme-modified',
          schemeName: 'oauth',
          oldScheme: parsedOauth(oldFlows),
          newScheme: parsedOauth(newFlows),
          details: 'oauth2 flows changed',
          classification: 'breaking',
        },
      ]);
      expect(exitCode(diff)).toBe(2);
      expect(onlyModified(diffSpecs(after, before))).toMatchObject({
        details: 'oauth2 flows changed',
        classification: 'breaking',
      });
    });

    it('a scope added to a flow is additive, `oauth2 scopes changed`, even on a scheme in use', async () => {
      const oldFlows = { clientCredentials: clientCredentials() };
      const newFlows = {
        clientCredentials: clientCredentials({ scopes: { 'pets:read': 'Read pets', 'pets:write': 'Write pets' } }),
      };
      const before = await parse(inUse(oldFlows));
      const after = await parse(inUse(newFlows));
      const diff = diffSpecs(before, after);
      expect(onlyModified(diff)).toMatchObject({
        schemeName: 'oauth',
        oldScheme: parsedOauth(oldFlows),
        newScheme: parsedOauth(newFlows),
        details: 'oauth2 scopes changed',
        classification: 'additive',
      });
      expect(diff.behaviorChanges).toEqual([
        {
          kind: 'security-scheme-changed',
          schemeName: 'oauth',
          oldScheme: parsedOauth(oldFlows),
          newScheme: parsedOauth(newFlows),
          classification: 'additive',
        },
      ]);
      expect(exitCode(diff)).toBe(1);
      // A scope removed, the other way, is the same additive entry.
      expect(onlyModified(diffSpecs(after, before))).toMatchObject({
        details: 'oauth2 scopes changed',
        classification: 'additive',
      });
    });

    it('a flow added beside an unchanged one is additive, exit 1 (MichaelDeBoey); removed, the other way, breaking', async () => {
      const oldFlows = { clientCredentials: clientCredentials() };
      const newFlows = {
        clientCredentials: clientCredentials(),
        authorizationCode: {
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          scopes: { 'pets:read': 'Read pets' },
        },
      };
      const before = await parse(inUse(oldFlows));
      const after = await parse(inUse(newFlows));
      // An alternative a caller may use, as `security-changed` reads one
      // added to a requirement: a caller built for `clientCredentials`
      // still gets its token the same way.
      expect(onlyModified(diffSpecs(before, after))).toMatchObject({
        details: 'oauth2 flows changed',
        classification: 'additive',
      });
      expect(exitCode(diffSpecs(before, after))).toBe(1);
      expect(onlyModified(diffSpecs(after, before))).toMatchObject({
        details: 'oauth2 flows changed',
        classification: 'breaking',
      });
    });

    it('a changed tokenUrl on a scheme nothing uses is additive', async () => {
      const unused = (flows: Record<string, unknown>): Doc => ({
        security: [{ apiKey: [] }],
        securitySchemes: { apiKey: xKey, oauth: oauth2(flows) },
      });
      const before = await parse(unused({ clientCredentials: clientCredentials() }));
      const after = await parse(
        unused({ clientCredentials: clientCredentials({ tokenUrl: 'https://auth.example.com/v2/token' }) }),
      );
      expect(onlyModified(diffSpecs(before, after))).toMatchObject({
        schemeName: 'oauth',
        details: 'oauth2 flows changed',
        classification: 'additive',
      });
      expect(exitCode(diffSpecs(before, after))).toBe(1);
    });
  });

  describe('a scheme added or removed', () => {
    it('added is additive, exit 1, whether or not a requirement names it', async () => {
      const before = await parse({ security: [{ apiKey: [] }], securitySchemes: { apiKey: xKey } });
      const unused = await parse({ security: [{ apiKey: [] }], securitySchemes: { apiKey: xKey, bearer } });
      const diff = diffSpecs(before, unused);
      expect(diff.changes).toEqual([
        { kind: 'security-scheme-added', schemeName: 'bearer', scheme: bearerScheme, classification: 'additive' },
      ]);
      expect(diff.behaviorChanges).toEqual([
        { kind: 'security-scheme-changed', schemeName: 'bearer', newScheme: bearerScheme, classification: 'additive' },
      ]);
      expect(diff.summary).toEqual({ added: 1, removed: 0, modified: 0, breaking: 0, additive: 1, behaviorChanges: 1 });
      expect(exitCode(diff)).toBe(1);

      // Named by a new alternative: the scheme is still additive; the
      // requirement change is the document's `security-changed` (additive
      // too, a caller may keep using `apiKey`).
      const used = await parse({
        security: [{ apiKey: [] }, { bearer: [] }],
        securitySchemes: { apiKey: xKey, bearer },
      });
      const withRequirement = diffSpecs(before, used);
      expect(withRequirement.changes.map((c) => [c.kind, c.classification])).toEqual([
        ['security-changed', 'additive'],
        ['security-scheme-added', 'additive'],
      ]);
      expect(exitCode(withRequirement)).toBe(1);
    });

    it('removed while an old operation used it is breaking, exit 2', async () => {
      // The old document's only request carried `apiKey`; the new one
      // carries `bearer` and no longer defines `apiKey`.
      const before = await parse({ security: [{ apiKey: [] }], securitySchemes: { apiKey: xKey, bearer } });
      const after = await parse({ security: [{ bearer: [] }], securitySchemes: { bearer } });
      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        {
          kind: 'security-changed',
          oldSecurity: [[{ schemeName: 'apiKey', scopes: [] }]],
          newSecurity: [[{ schemeName: 'bearer', scopes: [] }]],
          classification: 'breaking',
        },
        { kind: 'security-scheme-removed', schemeName: 'apiKey', scheme: xKeyScheme, classification: 'breaking' },
      ]);
      expect(diff.behaviorChanges).toEqual([
        {
          kind: 'security-changed',
          node: 'document',
          oldSecurity: [[{ schemeName: 'apiKey', scopes: [] }]],
          newSecurity: [[{ schemeName: 'bearer', scopes: [] }]],
          classification: 'breaking',
        },
        { kind: 'security-scheme-changed', schemeName: 'apiKey', oldScheme: xKeyScheme, classification: 'breaking' },
      ]);
      expect(diff.summary).toEqual({ added: 0, removed: 1, modified: 1, breaking: 2, additive: 0, behaviorChanges: 2 });
      expect(exitCode(diff)).toBe(2);
    });

    it('removed while nothing on either side used it is additive, exit 1', async () => {
      const before = await parse({ security: [{ bearer: [] }], securitySchemes: { apiKey: xKey, bearer } });
      const after = await parse({ security: [{ bearer: [] }], securitySchemes: { bearer } });
      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        { kind: 'security-scheme-removed', schemeName: 'apiKey', scheme: xKeyScheme, classification: 'additive' },
      ]);
      expect(diff.behaviorChanges).toEqual([
        { kind: 'security-scheme-changed', schemeName: 'apiKey', oldScheme: xKeyScheme, classification: 'additive' },
      ]);
      expect(exitCode(diff)).toBe(1);
      // The other way it is the scheme coming back, unused: additive.
      expect(diffSpecs(after, before).changes).toEqual([
        { kind: 'security-scheme-added', schemeName: 'apiKey', scheme: xKeyScheme, classification: 'additive' },
      ]);
    });

    it('removed while a requirement in the new document still names it is breaking, exit 2', async () => {
      // Nothing used `apiKey` before; the new document requires it on
      // `listPets` and no longer defines it.
      const before = await parse({ security: [{ bearer: [] }], securitySchemes: { apiKey: xKey, bearer } });
      const after = await parse({
        security: [{ bearer: [] }],
        securitySchemes: { bearer },
        paths: listPetsPath([{ apiKey: [] }]),
      });
      const diff = diffSpecs(before, after);
      expect(diff.changes.map((c) => [c.kind, c.classification])).toEqual([
        ['security-scheme-removed', 'breaking'],
        ['operation-modified', 'breaking'],
      ]);
      expect(diff.changes[0]).toEqual({
        kind: 'security-scheme-removed',
        schemeName: 'apiKey',
        scheme: xKeyScheme,
        classification: 'breaking',
      });
      expect(exitCode(diff)).toBe(2);
    });
  });

  describe('a scheme only a webhook uses: the handler reads it as a caller would', () => {
    // OpenAPI 3.0 has no `webhooks` map, so on 3.0.3 the receiver's case is
    // pinned on an operation that declares the scheme as its own list — the
    // same resolution (`node.security ?? spec.security`) with the same answer.
    const only = (scheme: Record<string, unknown>): Doc =>
      openapi === '3.1.0'
        ? {
            securitySchemes: { apiKey: scheme },
            paths: listPetsPath([]),
            webhooks: {
              petAdopted: { post: { security: [{ apiKey: [] }], responses: { '200': { description: 'ok' } } } },
            },
          }
        : { securitySchemes: { apiKey: scheme }, paths: listPetsPath([{ apiKey: [] }]) };

    it('a changed header name is breaking, exit 2', async () => {
      const before = await parse(only(xKey));
      const after = await parse(only(xApiKey));
      if (openapi === '3.1.0') {
        expect(before.webhooks?.map((w) => w.security)).toEqual([[[{ schemeName: 'apiKey', scopes: [] }]]]);
        expect(before.services[0].operations[0].security).toEqual([]);
      }
      const diff = diffSpecs(before, after);
      expect(onlyModified(diff)).toMatchObject({
        schemeName: 'apiKey',
        details: 'apiKey in header "X-Key" → in header "X-Api-Key"',
        classification: 'breaking',
      });
      expect(exitCode(diff)).toBe(2);
      expect(onlyModified(diffSpecs(after, before))).toMatchObject({ classification: 'breaking' });
    });

    it('a header name that only changed case is additive for the handler too, exit 1 (Greptile)', async () => {
      const before = await parse(only(xKey));
      const after = await parse(only({ type: 'apiKey', in: 'header', name: 'x-key' }));
      const diff = diffSpecs(before, after);
      expect(onlyModified(diff)).toMatchObject({
        schemeName: 'apiKey',
        details: 'apiKey in header "X-Key" → in header "x-key"',
        classification: 'additive',
      });
      expect(exitCode(diff)).toBe(1);
      expect(onlyModified(diffSpecs(after, before))).toMatchObject({ classification: 'additive' });
    });
  });

  describe('a header name that only changed case: reported, but additive, since header names are case-insensitive (Greptile)', () => {
    const xKeyLower = { type: 'apiKey', in: 'header', name: 'x-key' };
    const xKeyLowerScheme: AuthScheme = { kind: 'apiKey', schemeName: 'apiKey', in: 'header', name: 'x-key' };

    it('on a scheme in use: one additive security-scheme-modified with the spelling in details, exit 1, both directions', async () => {
      const before = await parse(issueOld());
      const after = await parse({ security: [{ apiKey: [] }], securitySchemes: { apiKey: xKeyLower } });
      expect(schemesInUse(after)).toEqual(new Set(['apiKey']));
      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        {
          kind: 'security-scheme-modified',
          schemeName: 'apiKey',
          oldScheme: xKeyScheme,
          newScheme: xKeyLowerScheme,
          details: 'apiKey in header "X-Key" → in header "x-key"',
          classification: 'additive',
        },
      ]);
      expect(diff.behaviorChanges).toEqual([
        {
          kind: 'security-scheme-changed',
          schemeName: 'apiKey',
          oldScheme: xKeyScheme,
          newScheme: xKeyLowerScheme,
          classification: 'additive',
        },
      ]);
      expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 0, additive: 1, behaviorChanges: 1 });
      expect(exitCode(diff)).toBe(1);

      const reverse = diffSpecs(after, before);
      expect(onlyModified(reverse)).toMatchObject({
        details: 'apiKey in header "x-key" → in header "X-Key"',
        classification: 'additive',
      });
      expect(exitCode(reverse)).toBe(1);
    });

    it('on a scheme nothing uses: additive too, exit 1, both directions', async () => {
      const before = await parse({ security: [{ bearer: [] }], securitySchemes: { apiKey: xKey, bearer } });
      const after = await parse({ security: [{ bearer: [] }], securitySchemes: { apiKey: xKeyLower, bearer } });
      expect(onlyModified(diffSpecs(before, after))).toMatchObject({
        details: 'apiKey in header "X-Key" → in header "x-key"',
        classification: 'additive',
      });
      expect(onlyModified(diffSpecs(after, before))).toMatchObject({ classification: 'additive' });
      expect(exitCode(diffSpecs(before, after))).toBe(1);
    });

    it('a query name that only changed case stays breaking in use: query names are case-sensitive', async () => {
      const inQuery = (name: string): Doc => ({
        security: [{ apiKey: [] }],
        securitySchemes: { apiKey: { type: 'apiKey', in: 'query', name } },
      });
      const before = await parse(inQuery('X-Key'));
      const after = await parse(inQuery('x-key'));
      expect(onlyModified(diffSpecs(before, after))).toMatchObject({
        details: 'apiKey in query "X-Key" → in query "x-key"',
        classification: 'breaking',
      });
      expect(onlyModified(diffSpecs(after, before))).toMatchObject({ classification: 'breaking' });
      expect(exitCode(diffSpecs(before, after))).toBe(2);
    });

    it('a header respelling that changes letters, or moves with its location, stays breaking in use', async () => {
      const before = await parse(issueOld());
      const respelled = await parse({
        security: [{ apiKey: [] }],
        securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
      });
      expect(onlyModified(diffSpecs(before, respelled))).toMatchObject({
        details: 'apiKey in header "X-Key" → in header "x-api-key"',
        classification: 'breaking',
      });
      expect(exitCode(diffSpecs(before, respelled))).toBe(2);
      const moved = await parse({
        security: [{ apiKey: [] }],
        securitySchemes: { apiKey: { type: 'apiKey', in: 'query', name: 'x-key' } },
      });
      expect(onlyModified(diffSpecs(before, moved))).toMatchObject({
        details: 'apiKey in header "X-Key" → in query "x-key"',
        classification: 'breaking',
      });
    });
  });

  describe('review 1 — a scheme added under a name the old document already had in use is breaking (MichaelDeBoey)', () => {
    const omitted: Array<[string, Record<string, unknown>]> = [
      [
        'openIdConnect',
        { type: 'openIdConnect', openIdConnectUrl: 'https://auth.pets.example.com/.well-known/openid-configuration' },
      ],
      ['http digest', { type: 'http', scheme: 'digest' }],
      // `mutualTLS` is an OAS 3.1 scheme type.
      ...(openapi === '3.1.0' ? [['mutualTLS', { type: 'mutualTLS' }] as [string, Record<string, unknown>]] : []),
    ];
    const petKey: AuthScheme = { kind: 'apiKey', schemeName: 'petKey', in: 'header', name: 'X-Key' };

    it.each(omitted)(
      '%s → apiKey under security: [{ petKey: [] }]: security-scheme-added, breaking, exit 2; the reverse is the breaking removal',
      async (_label, oldDefinition) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const before = await parse({ security: [{ petKey: [] }], securitySchemes: { petKey: oldDefinition } });
          const after = await parse({ security: [{ petKey: [] }], securitySchemes: { petKey: xKey } });
          // The parser omits the old definition, but the requirement still names it.
          expect(before.auth).toBeUndefined();
          expect(schemesInUse(before)).toEqual(new Set(['petKey']));

          const diff = diffSpecs(before, after);
          expect(diff.changes).toEqual([
            { kind: 'security-scheme-added', schemeName: 'petKey', scheme: petKey, classification: 'breaking' },
          ]);
          expect(diff.behaviorChanges).toEqual([
            { kind: 'security-scheme-changed', schemeName: 'petKey', newScheme: petKey, classification: 'breaking' },
          ]);
          expect(diff.summary).toEqual({
            added: 1,
            removed: 0,
            modified: 0,
            breaking: 1,
            additive: 0,
            behaviorChanges: 1,
          });
          expect(exitCode(diff)).toBe(2);

          const reverse = diffSpecs(after, before);
          expect(reverse.changes).toEqual([
            { kind: 'security-scheme-removed', schemeName: 'petKey', scheme: petKey, classification: 'breaking' },
          ]);
          expect(exitCode(reverse)).toBe(2);
        } finally {
          warn.mockRestore();
        }
      },
    );

    it('stays additive, exit 1, when the old document declared the omitted scheme but nothing used it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const before = await parse({
          security: [{ bearer: [] }],
          securitySchemes: { petKey: { type: 'http', scheme: 'digest' }, bearer },
        });
        const after = await parse({ security: [{ bearer: [] }], securitySchemes: { petKey: xKey, bearer } });
        const diff = diffSpecs(before, after);
        expect(diff.changes).toEqual([
          { kind: 'security-scheme-added', schemeName: 'petKey', scheme: petKey, classification: 'additive' },
        ]);
        expect(exitCode(diff)).toBe(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('review 2 — oauth2 flows: an extension is not a flow, and a flow or URL added is an alternative added (MichaelDeBoey)', () => {
    const inUse = (flows: Record<string, unknown>): Doc => ({
      security: [{ oauth: ['pets:read'] }],
      securitySchemes: { oauth: oauth2(flows) },
    });

    it('an x-* key on a flow, or beside the flows, is no change, exit 0, both directions', async () => {
      const before = await parse(inUse({ clientCredentials: clientCredentials() }));
      const onFlow = await parse(inUse({ clientCredentials: clientCredentials({ 'x-note': 'a' }) }));
      const besideFlows = await parse(inUse({ clientCredentials: clientCredentials(), 'x-note': 'a' }));
      // The parser keeps `flows` as written, extension included.
      expect(onFlow.auth?.[0]).toMatchObject({ flows: { clientCredentials: { 'x-note': 'a' } } });
      expect(besideFlows.auth?.[0]).toMatchObject({ flows: { 'x-note': 'a' } });
      for (const [a, b] of [
        [before, onFlow],
        [onFlow, before],
        [before, besideFlows],
        [besideFlows, before],
        [onFlow, besideFlows],
      ]) {
        const diff = diffSpecs(a, b);
        expect(diff.changes).toEqual([]);
        expect(diff.behaviorChanges).toEqual([]);
        expect(exitCode(diff)).toBe(0);
      }
    });

    it('a refreshUrl added to a flow that had none is additive, exit 1; removed, the other way, or changed, breaking, exit 2', async () => {
      const before = await parse(inUse({ clientCredentials: clientCredentials() }));
      const refreshed = await parse(
        inUse({ clientCredentials: clientCredentials({ refreshUrl: 'https://auth.example.com/refresh' }) }),
      );
      const moved = await parse(
        inUse({ clientCredentials: clientCredentials({ refreshUrl: 'https://auth.example.com/v2/refresh' }) }),
      );
      expect(onlyModified(diffSpecs(before, refreshed))).toMatchObject({
        details: 'oauth2 flows changed',
        classification: 'additive',
      });
      expect(exitCode(diffSpecs(before, refreshed))).toBe(1);
      expect(onlyModified(diffSpecs(refreshed, before))).toMatchObject({
        details: 'oauth2 flows changed',
        classification: 'breaking',
      });
      expect(exitCode(diffSpecs(refreshed, before))).toBe(2);
      expect(onlyModified(diffSpecs(refreshed, moved))).toMatchObject({ classification: 'breaking' });
      expect(onlyModified(diffSpecs(moved, refreshed))).toMatchObject({ classification: 'breaking' });
    });
  });

  describe('review 3 — a scope removed while a requirement in the new document still names it is breaking (MichaelDeBoey)', () => {
    const tokenUrl = 'https://auth.example.com/token';
    const petAuth = (scopes: Record<string, string>, security: unknown[], paths?: Record<string, unknown>): Doc => ({
      security,
      securitySchemes: { petAuth: oauth2({ clientCredentials: { tokenUrl, scopes } }) },
      ...(paths ? { paths } : {}),
    });
    const parsedPetAuth = (scopes: Record<string, string>): AuthScheme => ({
      kind: 'oauth2',
      schemeName: 'petAuth',
      flows: { clientCredentials: { tokenUrl, scopes } },
    });
    const both = { 'read:pets': 'Read pets', 'write:pets': 'Write pets' };
    const readOnly = { 'read:pets': 'Read pets' };

    it('his documents: write:pets dropped under security: [{ petAuth: [write:pets] }] exits 2, naming the scope', async () => {
      const before = await parse(petAuth(both, [{ petAuth: ['write:pets'] }]));
      const after = await parse(petAuth(readOnly, [{ petAuth: ['write:pets'] }]));
      expect(scopesInUse(after)).toEqual(new Map([['petAuth', new Set(['write:pets'])]]));
      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        {
          kind: 'security-scheme-modified',
          schemeName: 'petAuth',
          oldScheme: parsedPetAuth(both),
          newScheme: parsedPetAuth(readOnly),
          details: 'oauth2 scopes changed; required scope "write:pets" removed',
          classification: 'breaking',
        },
      ]);
      expect(diff.behaviorChanges).toEqual([
        {
          kind: 'security-scheme-changed',
          schemeName: 'petAuth',
          oldScheme: parsedPetAuth(both),
          newScheme: parsedPetAuth(readOnly),
          classification: 'breaking',
        },
      ]);
      expect(exitCode(diff)).toBe(2);
      // The scope coming back is a scope added: additive.
      const reverse = diffSpecs(after, before);
      expect(onlyModified(reverse)).toMatchObject({ details: 'oauth2 scopes changed', classification: 'additive' });
      expect(exitCode(reverse)).toBe(1);
    });

    it('stays additive, exit 1, when no requirement names the removed scope', async () => {
      const before = await parse(petAuth(both, [{ petAuth: ['read:pets'] }]));
      const after = await parse(petAuth(readOnly, [{ petAuth: ['read:pets'] }]));
      expect(onlyModified(diffSpecs(before, after))).toMatchObject({
        details: 'oauth2 scopes changed',
        classification: 'additive',
      });
      expect(exitCode(diffSpecs(before, after))).toBe(1);
      expect(onlyModified(diffSpecs(after, before))).toMatchObject({ classification: 'additive' });
    });

    it('reads the scopes an operation’s own requirement names, not only the document default’s', async () => {
      const paths = listPetsPath([{ petAuth: ['write:pets'] }]);
      const before = await parse(petAuth(both, [{ petAuth: ['read:pets'] }], paths));
      const after = await parse(petAuth(readOnly, [{ petAuth: ['read:pets'] }], paths));
      expect(onlyModified(diffSpecs(before, after))).toMatchObject({
        details: 'oauth2 scopes changed; required scope "write:pets" removed',
        classification: 'breaking',
      });
      expect(exitCode(diffSpecs(before, after))).toBe(2);
    });
  });

  describe('review 4 — a $ref under components.securitySchemes is followed and reported under the referencing key (MichaelDeBoey)', () => {
    const viaRef = (shared: Record<string, unknown>): Doc => ({
      security: [{ petKey: [] }],
      securitySchemes: { petKey: { $ref: '#/components/securitySchemes/sharedKey' }, sharedKey: shared },
    });
    const parsedAs = (schemeName: string, name: string): AuthScheme => ({
      kind: 'apiKey',
      schemeName,
      in: 'header',
      name,
    });

    it('his documents: sharedKey’s header renamed exits 2 as a breaking security-scheme-modified petKey', async () => {
      const before = await parse(viaRef(xKey));
      const after = await parse(viaRef(xApiKey));
      expect(before.auth).toEqual([parsedAs('petKey', 'X-Key'), parsedAs('sharedKey', 'X-Key')]);
      expect(schemesInUse(before)).toEqual(new Set(['petKey']));

      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        {
          kind: 'security-scheme-modified',
          schemeName: 'petKey',
          oldScheme: parsedAs('petKey', 'X-Key'),
          newScheme: parsedAs('petKey', 'X-Api-Key'),
          details: 'apiKey in header "X-Key" → in header "X-Api-Key"',
          classification: 'breaking',
        },
        // Nothing names `sharedKey` directly.
        {
          kind: 'security-scheme-modified',
          schemeName: 'sharedKey',
          oldScheme: parsedAs('sharedKey', 'X-Key'),
          newScheme: parsedAs('sharedKey', 'X-Api-Key'),
          details: 'apiKey in header "X-Key" → in header "X-Api-Key"',
          classification: 'additive',
        },
      ]);
      expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 2, breaking: 1, additive: 1, behaviorChanges: 2 });
      expect(exitCode(diff)).toBe(2);
      const reverse = diffSpecs(after, before);
      expect(exitCode(reverse)).toBe(2);
      expect(reverse.changes.map((c) => [c.kind, (c as SecuritySchemeModified).schemeName, c.classification])).toEqual([
        ['security-scheme-modified', 'petKey', 'breaking'],
        ['security-scheme-modified', 'sharedKey', 'additive'],
      ]);
    });
  });

  describe('a document default counts only through a node that inherits it', () => {
    const twoOperations = (security: { list?: unknown[]; get?: unknown[] }) => ({
      '/pets': { get: { operationId: 'listPets', ...(security.list ? { security: security.list } : {}), ...ok } },
      '/pets/{id}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          ...(security.get ? { security: security.get } : {}),
          ...ok,
        },
      },
    });

    it('`security: [{apiKey}]` that every operation overrides puts the scheme in no use: a modification is additive', async () => {
      const overridden = (scheme: Record<string, unknown>): Doc => ({
        security: [{ apiKey: [] }],
        securitySchemes: { apiKey: scheme, bearer },
        paths: twoOperations({ list: [{ bearer: [] }], get: [] }),
      });
      const before = await parse(overridden(xKey));
      const after = await parse(overridden(xApiKey));
      expect(schemesInUse(before)).toEqual(new Set(['bearer']));
      expect(onlyModified(diffSpecs(before, after))).toMatchObject({
        schemeName: 'apiKey',
        classification: 'additive',
      });
      expect(onlyModified(diffSpecs(after, before))).toMatchObject({
        schemeName: 'apiKey',
        classification: 'additive',
      });
      expect(exitCode(diffSpecs(before, after))).toBe(1);
    });

    it('the same with one operation inheriting: breaking', async () => {
      const inherited = (scheme: Record<string, unknown>): Doc => ({
        security: [{ apiKey: [] }],
        securitySchemes: { apiKey: scheme, bearer },
        paths: twoOperations({ list: [{ bearer: [] }] }),
      });
      const before = await parse(inherited(xKey));
      const after = await parse(inherited(xApiKey));
      expect(schemesInUse(before)).toEqual(new Set(['bearer', 'apiKey']));
      expect(onlyModified(diffSpecs(before, after))).toMatchObject({
        schemeName: 'apiKey',
        classification: 'breaking',
      });
      expect(onlyModified(diffSpecs(after, before))).toMatchObject({
        schemeName: 'apiKey',
        classification: 'breaking',
      });
      expect(exitCode(diffSpecs(before, after))).toBe(2);
    });
  });

  it('counts each kind in the summary and lists them after security-changed, before the models', async () => {
    const pet = (properties: Record<string, unknown>) => ({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, ...properties },
    });
    const petsPath = {
      '/pets': {
        get: {
          operationId: 'listPets',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
            },
          },
        },
      },
    };
    const before = await parse({
      security: [{ apiKey: [] }],
      securitySchemes: { apiKey: xKey, legacy: basic },
      schemas: { Pet: pet({}) },
      paths: petsPath,
    });
    const after = await parse({
      security: [{ bearer: [] }],
      securitySchemes: { apiKey: xApiKey, bearer },
      schemas: { Pet: pet({ name: { type: 'string' } }) },
      paths: petsPath,
    });
    const diff = diffSpecs(before, after);
    expect(diff.changes.map((c) => [c.kind, c.classification])).toEqual([
      // The caller now needs `bearer`.
      ['security-changed', 'breaking'],
      // Added, then removed, then modified; `apiKey` is in use nowhere in the
      // new document, and `legacy` was in use nowhere, so both are additive.
      ['security-scheme-added', 'additive'],
      ['security-scheme-removed', 'additive'],
      ['security-scheme-modified', 'additive'],
      ['model-modified', 'additive'],
    ]);
    expect(diff.changes.slice(1, 4)).toEqual([
      { kind: 'security-scheme-added', schemeName: 'bearer', scheme: bearerScheme, classification: 'additive' },
      {
        kind: 'security-scheme-removed',
        schemeName: 'legacy',
        scheme: { kind: 'basic', schemeName: 'legacy' },
        classification: 'additive',
      },
      {
        kind: 'security-scheme-modified',
        schemeName: 'apiKey',
        oldScheme: xKeyScheme,
        newScheme: xApiKeyScheme,
        details: 'apiKey in header "X-Key" → in header "X-Api-Key"',
        classification: 'additive',
      },
    ]);
    expect(diff.behaviorChanges.map((c) => c.kind)).toEqual([
      'security-changed',
      'security-scheme-changed',
      'security-scheme-changed',
      'security-scheme-changed',
    ]);
    expect(diff.summary).toEqual({ added: 1, removed: 1, modified: 3, breaking: 1, additive: 4, behaviorChanges: 4 });
    expect(exitCode(diff)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Hand-built IR through the differ's functions.
// ---------------------------------------------------------------------------

const apiKeyRequirement: SecurityRequirementSet[] = [[{ schemeName: 'apiKey', scopes: [] }]];
const bearerRequirement: SecurityRequirementSet[] = [[{ schemeName: 'bearer', scopes: [] }]];

const listPets: Operation = {
  name: 'listPets',
  httpMethod: 'get',
  path: '/pets',
  pathParams: [],
  queryParams: [],
  headerParams: [],
  response: { kind: 'primitive', type: 'string' },
  errors: [],
  injectIdempotencyKey: false,
};

/** `listPets` carrying the given fields; an `undefined` value drops the key. */
function op(overrides: Partial<Operation> = {}): Operation {
  const merged: Operation = { ...listPets, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key as keyof Operation];
  }
  return merged;
}

const petAdopted: Webhook = {
  name: 'petAdopted',
  httpMethod: 'post',
  headerParams: [],
  queryParams: [],
  requestBody: { kind: 'primitive', type: 'string' },
  responses: [{ statusCode: 200 }],
};

function spec(overrides: Partial<ApiSpec> = {}): ApiSpec {
  return {
    name: 'Pets',
    version: '1',
    baseUrl: 'https://api.example.com',
    services: [{ name: 'Pets', operations: [listPets] }],
    models: [],
    enums: [],
    sdk: defaultSdkBehavior(),
    ...overrides,
  };
}

const header: AuthScheme = { kind: 'apiKey', schemeName: 'apiKey', in: 'header', name: 'X-Key' };
const cookie: AuthScheme = { kind: 'apiKey', schemeName: 'apiKey', in: 'cookie', name: 'session' };
/** The `apiKey` scheme at `location` under `name`. */
const apiKeyAt = (location: 'header' | 'query' | 'cookie', name: string): AuthScheme => ({
  kind: 'apiKey',
  schemeName: 'apiKey',
  in: location,
  name,
});
const basicAuth: AuthScheme = { kind: 'basic', schemeName: 'apiKey' };
const bearerAuth: AuthScheme = { kind: 'bearer', schemeName: 'apiKey' };
const oauth = (flows: Record<string, unknown>): AuthScheme => ({ kind: 'oauth2', schemeName: 'apiKey', flows });

describe('#384 diffSpecs on hand-built IR', () => {
  it('reads `auth` absent and `[]` as no schemes: no change either way', () => {
    const absent = spec();
    const empty = spec({ auth: [] });
    for (const [a, b] of [
      [absent, empty],
      [empty, absent],
      [absent, absent],
      [empty, empty],
    ]) {
      const diff = diffSpecs(a, b);
      expect(diff.changes).toEqual([]);
      expect(diff.behaviorChanges).toEqual([]);
    }
    expect(diffAuthSchemes(absent, empty)).toEqual([]);
    expect(diffAuthSchemes(empty, absent)).toEqual([]);
  });

  it('lists the scheme changes right after security-changed and mirrors each into behaviorChanges', () => {
    const before = spec({ security: apiKeyRequirement, auth: [header] });
    const after = spec({ security: bearerRequirement, auth: [{ kind: 'bearer', schemeName: 'bearer' }] });
    const diff = diffSpecs(before, after);
    expect(diff.changes.map((c) => c.kind)).toEqual([
      'security-changed',
      'security-scheme-added',
      'security-scheme-removed',
    ]);
    expect(diff.behaviorChanges).toEqual([
      {
        kind: 'security-changed',
        node: 'document',
        oldSecurity: apiKeyRequirement,
        newSecurity: bearerRequirement,
        classification: 'breaking',
      },
      {
        kind: 'security-scheme-changed',
        schemeName: 'bearer',
        newScheme: { kind: 'bearer', schemeName: 'bearer' },
        classification: 'additive',
      },
      { kind: 'security-scheme-changed', schemeName: 'apiKey', oldScheme: header, classification: 'breaking' },
    ]);
    expect(diff.summary).toEqual({ added: 1, removed: 1, modified: 1, breaking: 2, additive: 1, behaviorChanges: 3 });
  });

  it('carries no oldScheme on an added entry and no newScheme on a removed one', () => {
    const [added] = diffSpecs(spec(), spec({ auth: [header] })).behaviorChanges;
    expect(added).not.toHaveProperty('oldScheme');
    expect(added).toHaveProperty('newScheme', header);
    const [removed] = diffSpecs(spec({ auth: [header] }), spec()).behaviorChanges;
    expect(removed).not.toHaveProperty('newScheme');
    expect(removed).toHaveProperty('oldScheme', header);
  });
});

describe('#384 schemesInUse', () => {
  it('names the schemes of every operation’s and webhook’s effective list', () => {
    const used = schemesInUse(
      spec({
        security: apiKeyRequirement,
        services: [{ name: 'Pets', operations: [op(), op({ name: 'getPet', security: bearerRequirement })] }],
        webhooks: [{ ...petAdopted, security: [[{ schemeName: 'hook', scopes: ['events'] }]] }],
      }),
    );
    expect(used).toEqual(new Set(['apiKey', 'bearer', 'hook']));
  });

  it('counts the document default only through a node that inherits it', () => {
    expect(schemesInUse(spec({ security: apiKeyRequirement }))).toEqual(new Set(['apiKey']));
    expect(
      schemesInUse(
        spec({ security: apiKeyRequirement, services: [{ name: 'Pets', operations: [op({ security: [] })] }] }),
      ),
    ).toEqual(new Set());
    expect(
      schemesInUse(
        spec({
          security: apiKeyRequirement,
          services: [{ name: 'Pets', operations: [op({ security: bearerRequirement })] }],
        }),
      ),
    ).toEqual(new Set(['bearer']));
    // A default no node is there to inherit is read by nothing.
    expect(schemesInUse(spec({ security: apiKeyRequirement, services: [] }))).toEqual(new Set());
  });

  it('is empty when nothing declares a requirement', () => {
    expect(schemesInUse(spec())).toEqual(new Set());
    expect(schemesInUse(spec({ security: [] }))).toEqual(new Set());
    // An anonymous alternative names no scheme.
    expect(schemesInUse(spec({ security: [...apiKeyRequirement, []] }))).toEqual(new Set(['apiKey']));
  });
});

describe('#384 diffAuthSchemes', () => {
  /** The one change between two `auth` lists under the given requirements, or `undefined`. */
  function change(
    oldAuth: AuthScheme[] | undefined,
    newAuth: AuthScheme[] | undefined,
    security: { old?: SecurityRequirementSet[]; new?: SecurityRequirementSet[] } = {},
  ): SecuritySchemeChange | undefined {
    const changes = diffAuthSchemes(
      spec({ auth: oldAuth, security: security.old }),
      spec({ auth: newAuth, security: security.new }),
    );
    expect(changes.length).toBeLessThanOrEqual(1);
    return changes[0];
  }
  const used = { old: apiKeyRequirement, new: apiKeyRequirement };

  describe('modified', () => {
    it('reports a changed kind with both kinds in `details`', () => {
      expect(change([header], [basicAuth], used)).toMatchObject({
        details: 'apiKey → http basic',
        classification: 'breaking',
      });
      expect(change([header], [bearerAuth], used)).toMatchObject({ details: 'apiKey → http bearer' });
      expect(change([basicAuth], [bearerAuth], used)).toMatchObject({
        details: 'http basic → http bearer',
        classification: 'breaking',
      });
      expect(change([bearerAuth], [oauth({})], used)).toMatchObject({
        details: 'http bearer → oauth2',
        classification: 'breaking',
      });
      expect(change([oauth({})], [header], used)).toMatchObject({
        details: 'oauth2 → apiKey',
        classification: 'breaking',
      });
    });

    it('reports an apiKey moved to a cookie with the location and name on each side', () => {
      expect(change([header], [cookie], used)).toEqual({
        kind: 'security-scheme-modified',
        schemeName: 'apiKey',
        oldScheme: header,
        newScheme: cookie,
        details: 'apiKey in header "X-Key" → in cookie "session"',
        classification: 'breaking',
      });
    });

    it('folds a header name before comparing the wire form: a case-only respelling is reported, in use, but additive (Greptile)', () => {
      const lower = apiKeyAt('header', 'x-key');
      expect(change([header], [lower], used)).toEqual({
        kind: 'security-scheme-modified',
        schemeName: 'apiKey',
        oldScheme: header,
        newScheme: lower,
        details: 'apiKey in header "X-Key" → in header "x-key"',
        classification: 'additive',
      });
      expect(change([lower], [header], used)).toMatchObject({
        details: 'apiKey in header "x-key" → in header "X-Key"',
        classification: 'additive',
      });
      expect(change([header], [lower])).toMatchObject({ classification: 'additive' });
      // Query and cookie names are case-sensitive, so the same respelling
      // there is a wire-form change.
      expect(change([apiKeyAt('query', 'X-Key')], [apiKeyAt('query', 'x-key')], used)).toMatchObject({
        details: 'apiKey in query "X-Key" → in query "x-key"',
        classification: 'breaking',
      });
      expect(change([cookie], [apiKeyAt('cookie', 'SESSION')], used)).toMatchObject({
        details: 'apiKey in cookie "session" → in cookie "SESSION"',
        classification: 'breaking',
      });
      // A folded name that still differs, or a location that moved with
      // the case, is breaking.
      expect(change([header], [apiKeyAt('header', 'x-api-key')], used)).toMatchObject({ classification: 'breaking' });
      expect(change([header], [apiKeyAt('query', 'x-key')], used)).toMatchObject({ classification: 'breaking' });
    });

    it('is additive for any wire-form change on a scheme the new document does not use', () => {
      // In use in the old document only: the requirement change is
      // `security-changed`'s, and no new request carries the old form.
      expect(change([header], [basicAuth], { old: apiKeyRequirement })).toMatchObject({ classification: 'additive' });
      expect(change([header], [cookie], { old: apiKeyRequirement, new: bearerRequirement })).toMatchObject({
        classification: 'additive',
      });
      expect(change([header], [cookie])).toMatchObject({ classification: 'additive' });
    });

    it('is breaking for a wire-form change on a scheme only the new document uses', () => {
      expect(change([header], [cookie], { new: apiKeyRequirement })).toMatchObject({ classification: 'breaking' });
    });

    it('compares oauth2 flows deeply, key order aside', () => {
      const flows = { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: { a: 'A', b: 'B' } } };
      const reordered = {
        clientCredentials: { scopes: { b: 'B', a: 'A' }, tokenUrl: 'https://auth.example.com/token' },
      };
      expect(change([oauth(flows)], [oauth(reordered)], used)).toBeUndefined();
      expect(
        change(
          [
            oauth({
              implicit: { authorizationUrl: 'https://a', scopes: {} },
              clientCredentials: flows.clientCredentials,
            }),
          ],
          [
            oauth({
              clientCredentials: flows.clientCredentials,
              implicit: { authorizationUrl: 'https://a', scopes: {} },
            }),
          ],
          used,
        ),
      ).toBeUndefined();
    });

    it('takes each flow’s scopes out of the wire form, so a scope re-described is additive, and reads a key added as an alternative', () => {
      const flows = { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: { a: 'A' } } };
      const redescribed = {
        clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: { a: 'Read A' } },
      };
      expect(change([oauth(flows)], [oauth(redescribed)], used)).toMatchObject({
        details: 'oauth2 scopes changed',
        classification: 'additive',
      });
      // A `refreshUrl` added to a flow that had none is additive
      // (MichaelDeBoey): a caller still gets its token as before.
      const refreshed = {
        clientCredentials: { ...flows.clientCredentials, refreshUrl: 'https://auth.example.com/refresh' },
      };
      expect(change([oauth(flows)], [oauth(refreshed)], used)).toMatchObject({
        details: 'oauth2 flows changed',
        classification: 'additive',
      });
      // An `x-*` key on a flow is an extension, not a flow (MichaelDeBoey).
      const extended = { clientCredentials: { ...flows.clientCredentials, 'x-audience': 'pets' } };
      expect(change([oauth(flows)], [oauth(extended)], used)).toBeUndefined();
      // A flow removed, and a flow that is not an object (a malformed
      // document, kept as the parser read it), are wire-form changes too.
      expect(
        change([oauth({ ...flows, implicit: { authorizationUrl: 'https://a', scopes: {} } })], [oauth(flows)], used),
      ).toMatchObject({
        details: 'oauth2 flows changed',
        classification: 'breaking',
      });
      expect(change([oauth({ clientCredentials: 'x' })], [oauth({ clientCredentials: 'y' })], used)).toMatchObject({
        details: 'oauth2 flows changed',
        classification: 'breaking',
      });
    });

    it('ignores `description` on every kind', () => {
      expect(change([header], [{ ...header, description: 'The key' }], used)).toBeUndefined();
      expect(change([basicAuth], [{ ...basicAuth, description: 'Basic' }], used)).toBeUndefined();
      expect(change([{ ...bearerAuth, description: '' }], [bearerAuth], used)).toBeUndefined();
      expect(change([oauth({})], [{ ...oauth({}), description: 'OAuth' }], used)).toBeUndefined();
    });
  });

  describe('removed', () => {
    it('is breaking when the old document used it, whatever the new one does', () => {
      expect(change([header], undefined, { old: apiKeyRequirement })).toEqual({
        kind: 'security-scheme-removed',
        schemeName: 'apiKey',
        scheme: header,
        classification: 'breaking',
      });
      expect(change([header], [], { old: apiKeyRequirement, new: bearerRequirement })).toMatchObject({
        classification: 'breaking',
      });
    });

    it('is breaking when a requirement in the new document still names it', () => {
      expect(change([header], [], { new: apiKeyRequirement })).toMatchObject({
        kind: 'security-scheme-removed',
        classification: 'breaking',
      });
    });

    it('is additive when nothing on either side used it', () => {
      expect(change([header], [])).toMatchObject({ kind: 'security-scheme-removed', classification: 'additive' });
      expect(change([header], undefined, { old: bearerRequirement, new: bearerRequirement })).toMatchObject({
        classification: 'additive',
      });
    });

    it('reads a document default the new document’s only operation overrides as not in use', () => {
      // The new default names `apiKey`, but no request carries it.
      const changes = diffAuthSchemes(
        spec({ auth: [header] }),
        spec({ security: apiKeyRequirement, services: [{ name: 'Pets', operations: [op({ security: [] })] }] }),
      );
      expect(changes).toEqual([
        { kind: 'security-scheme-removed', schemeName: 'apiKey', scheme: header, classification: 'additive' },
      ]);
    });
  });

  describe('review 1 — added (MichaelDeBoey)', () => {
    it('is breaking when the old document had the scheme in use, additive otherwise', () => {
      expect(change(undefined, [header], { old: apiKeyRequirement })).toEqual({
        kind: 'security-scheme-added',
        schemeName: 'apiKey',
        scheme: header,
        classification: 'breaking',
      });
      expect(change([], [header], { old: apiKeyRequirement, new: apiKeyRequirement })).toMatchObject({
        classification: 'breaking',
      });
      // Named only by the new document: the requirement change is
      // `security-changed`'s, and no old request carried the scheme.
      expect(change([], [header], { new: apiKeyRequirement })).toMatchObject({
        kind: 'security-scheme-added',
        classification: 'additive',
      });
      expect(change([], [header])).toMatchObject({ classification: 'additive' });
      // A default every old operation overrides put nothing in use.
      expect(
        diffAuthSchemes(
          spec({ security: apiKeyRequirement, services: [{ name: 'Pets', operations: [op({ security: [] })] }] }),
          spec({ auth: [header] }),
        ),
      ).toEqual([{ kind: 'security-scheme-added', schemeName: 'apiKey', scheme: header, classification: 'additive' }]);
    });
  });

  describe('review 2 — oauth2 flows (MichaelDeBoey)', () => {
    const cc = { tokenUrl: 'https://auth.example.com/token', scopes: { a: 'A' } };
    const ac = { authorizationUrl: 'https://auth.example.com/authorize', tokenUrl: cc.tokenUrl, scopes: { a: 'A' } };

    it('drops x-* keys from the flows object and from each flow: an extension edit is no change', () => {
      expect(
        change([oauth({ clientCredentials: cc })], [oauth({ clientCredentials: { ...cc, 'x-note': 'a' } })], used),
      ).toBeUndefined();
      expect(
        change([oauth({ clientCredentials: cc })], [oauth({ clientCredentials: cc, 'x-note': 'a' })], used),
      ).toBeUndefined();
      expect(
        change(
          [oauth({ clientCredentials: { ...cc, 'x-note': 'a' }, 'x-id': 1 })],
          [oauth({ clientCredentials: { ...cc, 'x-note': 'b' }, 'x-id': 2 })],
          used,
        ),
      ).toBeUndefined();
    });

    it('reads a flow added, or a key a flow lacked, as an alternative added: additive in use', () => {
      expect(
        change([oauth({ clientCredentials: cc })], [oauth({ clientCredentials: cc, authorizationCode: ac })], used),
      ).toMatchObject({
        details: 'oauth2 flows changed',
        classification: 'additive',
      });
      const refreshed = { ...cc, refreshUrl: 'https://auth.example.com/refresh' };
      expect(change([oauth({ clientCredentials: cc })], [oauth({ clientCredentials: refreshed })], used)).toMatchObject(
        {
          details: 'oauth2 flows changed',
          classification: 'additive',
        },
      );
    });

    it('reads a flow removed, or a URL a flow declared changed or removed, as breaking in use', () => {
      const refreshed = { ...cc, refreshUrl: 'https://auth.example.com/refresh' };
      expect(
        change([oauth({ clientCredentials: cc, authorizationCode: ac })], [oauth({ clientCredentials: cc })], used),
      ).toMatchObject({
        details: 'oauth2 flows changed',
        classification: 'breaking',
      });
      expect(change([oauth({ clientCredentials: refreshed })], [oauth({ clientCredentials: cc })], used)).toMatchObject(
        {
          classification: 'breaking',
        },
      );
      expect(
        change(
          [oauth({ clientCredentials: refreshed })],
          [oauth({ clientCredentials: { ...refreshed, refreshUrl: 'https://auth.example.com/v2/refresh' } })],
          used,
        ),
      ).toMatchObject({ classification: 'breaking' });
      expect(
        change(
          [oauth({ clientCredentials: cc })],
          [oauth({ clientCredentials: { ...cc, tokenUrl: 'https://auth.example.com/v2/token' } })],
          used,
        ),
      ).toMatchObject({
        classification: 'breaking',
      });
      // Out of use in the new document, the same regression is additive.
      expect(
        change([oauth({ clientCredentials: cc, authorizationCode: ac })], [oauth({ clientCredentials: cc })], {
          old: apiKeyRequirement,
        }),
      ).toMatchObject({
        classification: 'additive',
      });
    });
  });

  describe('review 3 — a required scope removed (MichaelDeBoey)', () => {
    const flows = (scopes: Record<string, string>) => ({
      clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes },
    });
    /** A requirement on the scheme (`apiKey`, as the `oauth` helper names it) asking for `scopes`. */
    const needs = (...scopes: string[]): SecurityRequirementSet[] => [[{ schemeName: 'apiKey', scopes }]];

    it('is breaking when a requirement in the new document still names the scope, with the scope in details', () => {
      expect(
        change([oauth(flows({ read: 'R', write: 'W' }))], [oauth(flows({ read: 'R' }))], {
          old: needs('write'),
          new: needs('write'),
        }),
      ).toMatchObject({
        details: 'oauth2 scopes changed; required scope "write" removed',
        classification: 'breaking',
      });
      // Named by the new document alone is enough: that is what asks for it.
      expect(
        change([oauth(flows({ read: 'R', write: 'W' }))], [oauth(flows({ read: 'R' }))], { new: needs('write') }),
      ).toMatchObject({
        classification: 'breaking',
      });
    });

    it('is additive when no requirement names it, when it was added or re-described, or when another flow still offers it', () => {
      expect(
        change([oauth(flows({ read: 'R', write: 'W' }))], [oauth(flows({ read: 'R' }))], {
          old: needs('write'),
          new: needs('read'),
        }),
      ).toMatchObject({
        details: 'oauth2 scopes changed',
        classification: 'additive',
      });
      expect(
        change([oauth(flows({ read: 'R' }))], [oauth(flows({ read: 'R', write: 'W' }))], { new: needs('write') }),
      ).toMatchObject({
        details: 'oauth2 scopes changed',
        classification: 'additive',
      });
      expect(
        change([oauth(flows({ write: 'W' }))], [oauth(flows({ write: 'Write' }))], { new: needs('write') }),
      ).toMatchObject({
        classification: 'additive',
      });
      const implicit = { authorizationUrl: 'https://auth.example.com/authorize', scopes: { write: 'W' } };
      expect(
        change(
          [oauth({ ...flows({ read: 'R', write: 'W' }), implicit })],
          [oauth({ ...flows({ read: 'R' }), implicit })],
          { new: needs('write') },
        ),
      ).toMatchObject({ details: 'oauth2 scopes changed', classification: 'additive' });
    });

    it('names every required scope removed, sorted, beside a flows change too', () => {
      expect(
        change([oauth(flows({ a: 'A', b: 'B', c: 'C' }))], [oauth(flows({}))], { new: needs('c', 'a') }),
      ).toMatchObject({
        details: 'oauth2 scopes changed; required scopes "a", "c" removed',
        classification: 'breaking',
      });
      const implicit = { authorizationUrl: 'https://auth.example.com/authorize', scopes: {} };
      expect(
        change([oauth(flows({ a: 'A' }))], [oauth({ ...flows({}), implicit })], { new: needs('a') }),
      ).toMatchObject({
        details: 'oauth2 flows changed; required scope "a" removed',
        classification: 'breaking',
      });
    });

    it('reads the scopes from every effective requirement (scopesInUse)', () => {
      expect(
        scopesInUse(
          spec({
            security: needs('a'),
            services: [{ name: 'Pets', operations: [op(), op({ name: 'getPet', security: needs('b', 'a') })] }],
            webhooks: [{ ...petAdopted, security: [[{ schemeName: 'hook', scopes: ['c'] }]] }],
          }),
        ),
      ).toEqual(
        new Map([
          ['apiKey', new Set(['a', 'b'])],
          ['hook', new Set(['c'])],
        ]),
      );
      expect(
        scopesInUse(spec({ security: needs('a'), services: [{ name: 'Pets', operations: [op({ security: [] })] }] })),
      ).toEqual(new Map());
    });
  });

  it('lists added schemes first, then removed, then modified, each in its document’s order', () => {
    const second: AuthScheme = { kind: 'bearer', schemeName: 'second' };
    const third: AuthScheme = { kind: 'basic', schemeName: 'third' };
    const fourth: AuthScheme = { kind: 'bearer', schemeName: 'fourth' };
    const changes = diffAuthSchemes(
      spec({ auth: [header, second, third] }),
      spec({ auth: [fourth, cookie, { kind: 'basic', schemeName: 'second' }] }),
    );
    expect(changes.map((c) => [c.kind, c.schemeName])).toEqual([
      ['security-scheme-added', 'fourth'],
      ['security-scheme-removed', 'third'],
      ['security-scheme-modified', 'apiKey'],
      ['security-scheme-modified', 'second'],
    ]);
  });

  it('types its changes as the package exports them', () => {
    const added: SecuritySchemeAdded = {
      kind: 'security-scheme-added',
      schemeName: 'apiKey',
      scheme: header,
      classification: 'additive',
    };
    const removed: SecuritySchemeRemoved = {
      kind: 'security-scheme-removed',
      schemeName: 'apiKey',
      scheme: header,
      classification: 'breaking',
    };
    const modified: SecuritySchemeModified = {
      kind: 'security-scheme-modified',
      schemeName: 'apiKey',
      oldScheme: header,
      newScheme: cookie,
      details: 'apiKey in header "X-Key" → in cookie "session"',
      classification: 'breaking',
    };
    const mirrored: SecuritySchemeChanged = {
      kind: 'security-scheme-changed',
      schemeName: 'apiKey',
      oldScheme: header,
      classification: 'breaking',
    };
    expect(diffAuthSchemes(spec(), spec({ auth: [header] }))).toEqual([added]);
    expect(diffAuthSchemes(spec({ auth: [header], security: apiKeyRequirement }), spec())).toEqual([removed]);
    expect(diffAuthSchemes(spec({ auth: [header] }), spec({ auth: [cookie], security: apiKeyRequirement }))).toEqual([
      modified,
    ]);
    expect(diffSpecs(spec({ auth: [header], security: apiKeyRequirement }), spec()).behaviorChanges).toEqual([
      {
        kind: 'security-changed',
        node: 'document',
        oldSecurity: apiKeyRequirement,
        newSecurity: [],
        classification: 'additive',
      },
      mirrored,
    ]);
  });
});
