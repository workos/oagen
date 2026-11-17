/**
 * Issue #662: `oagen diff` compares an `openIdConnect`, a `mutualTLS` and an
 * `http` security scheme (any scheme other than `basic` and `bearer`) as it
 * compares the other kinds (#384), now that `ApiSpec.auth` carries them: a
 * changed `openIdConnectUrl` or `http` scheme name is a
 * `security-scheme-modified` that breaks in use, an unused scheme added or
 * removed is additive, one removed while a requirement still names it is
 * breaking, and a changed kind (`openIdConnect → apiKey`) is a breaking
 * `security-scheme-modified`, not an added scheme. An `http` scheme name is
 * compared case-insensitively (RFC 9110 §11.1), so `Digest` → `digest` is no
 * change, as `Bearer` → `bearer` is none.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffSpecs } from '../../src/differ/diff.js';
import { diffAuthSchemes, schemesInUse } from '../../src/differ/auth.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { DiffReport } from '../../src/differ/types.js';
import { parseSpec } from '../../src/parser/parse.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';
import type { ApiSpec, AuthScheme, Webhook } from '../../src/ir/types.js';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

let written = 0;
async function write(doc: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-diff-auth-scheme-kinds-'));
  dirs.push(dir);
  const file = path.join(dir, `${written++}.json`);
  await fs.writeFile(file, JSON.stringify(doc));
  return file;
}

type Schemes = Record<string, Record<string, unknown>>;

const oidcUrl = 'https://auth.example.com/.well-known/openid-configuration';
const loginUrl = 'https://login.example.com/.well-known/openid-configuration';
const json = (schema: unknown) => ({ 'application/json': { schema } });
const petId = { type: 'object', properties: { petId: { type: 'string' } } };
const apiKey = { type: 'apiKey', in: 'header', name: 'X-Pet-Key' };

/** The four schemes the issue's `repro.json` declares, in its order. */
const baseSchemes = (): Schemes => ({
  petAuth: { type: 'openIdConnect', openIdConnectUrl: oidcUrl },
  petCert: { type: 'mutualTLS' },
  petDigest: { type: 'http', scheme: 'Digest' },
  petToken: { type: 'http', scheme: 'Bearer' },
});

/** `baseSchemes` after `change`. */
function edited(change: (schemes: Schemes) => void): Schemes {
  const schemes = baseSchemes();
  change(schemes);
  return schemes;
}

/** `baseSchemes` with `petAuth` replaced by `entries`, in its place. */
function replacingPetAuth(entries: Schemes): Schemes {
  const { petAuth: _dropped, ...rest } = baseSchemes();
  return { ...entries, ...rest };
}

/**
 * The issue's document: `GET /pets` (listPets) requiring `auth` with
 * `read:pets`, `POST /pets` (createPet) requiring `petDigest` with a
 * callback `petAdopted` requiring `auth` with `write:pets`, and on 3.1 a
 * webhook `petReturned` requiring `petCert`. `auth` is the name the
 * requirements use for `petAuth` (`petOidc` in `renamed.json`). The 3.0.3
 * copy is "without `petCert` and the webhook".
 */
function issueDocument(openapi: string, schemes: Schemes, auth = 'petAuth') {
  const is31 = openapi.startsWith('3.1');
  const securitySchemes = { ...schemes };
  if (!is31) delete securitySchemes.petCert;
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          security: [{ [auth]: ['read:pets'] }],
          responses: { '200': { description: 'OK' } },
        },
        post: {
          operationId: 'createPet',
          security: [{ petDigest: [] }],
          requestBody: { content: json({ type: 'object', properties: { callbackUrl: { type: 'string' } } }) },
          responses: { '201': { description: 'Created' } },
          callbacks: {
            petAdopted: {
              '{$request.body#/callbackUrl}': {
                post: {
                  security: [{ [auth]: ['write:pets'] }],
                  requestBody: { content: json(petId) },
                  responses: { '204': { description: 'No content' } },
                },
              },
            },
          },
        },
      },
    },
    ...(is31
      ? {
          webhooks: {
            petReturned: {
              post: {
                security: [{ petCert: [] }],
                requestBody: { content: json(petId) },
                responses: { '204': { description: 'No content' } },
              },
            },
          },
        }
      : {}),
    components: { securitySchemes },
  };
}

/** The exit code `oagen diff` gives a report: 2 breaking, 1 any other change, 0 none. */
function exitCode(report: DiffReport): 0 | 1 | 2 {
  const { breaking, modified, removed, added } = report.summary;
  return breaking > 0 ? 2 : modified > 0 || removed > 0 || added > 0 ? 1 : 0;
}

/** Each change as `kind name classification`, in report order. */
function summarized(report: DiffReport): string[] {
  return report.changes.map((change) => {
    const named = change as { schemeName?: string; operationName?: string; name?: string };
    // A callback change names its callback in `name` and its owner in `operationName`.
    const name = change.kind === 'callback-modified' ? named.name : (named.schemeName ?? named.operationName);
    return `${change.kind} ${name} ${change.classification}`;
  });
}

/** The schemes as the parser reads them. */
const petAuth: AuthScheme = { kind: 'openIdConnect', schemeName: 'petAuth', openIdConnectUrl: oidcUrl };
const petAuthMoved: AuthScheme = { kind: 'openIdConnect', schemeName: 'petAuth', openIdConnectUrl: loginUrl };
const petAuthKey: AuthScheme = { kind: 'apiKey', schemeName: 'petAuth', in: 'header', name: 'X-Pet-Key' };
const petCert: AuthScheme = { kind: 'mutualTLS', schemeName: 'petCert' };
const petDigest: AuthScheme = { kind: 'http', schemeName: 'petDigest', scheme: 'Digest' };
const petHoba: AuthScheme = { kind: 'http', schemeName: 'petDigest', scheme: 'hoba' };
const petLogin: AuthScheme = { kind: 'openIdConnect', schemeName: 'petLogin', openIdConnectUrl: oidcUrl };

describe.each(['3.0.3', '3.1.0'])('#662 on OAS %s — oagen diff over the issue’s documents', (openapi) => {
  const is31 = openapi === '3.1.0';
  const file = (schemes: Schemes, auth?: string) => write(issueDocument(openapi, schemes, auth));
  const parse = async (schemes: Schemes, auth?: string): Promise<ApiSpec> => parseSpec(await file(schemes, auth));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The issue's documents by name, as files, for `oagen diff --old … --new …`. */
  const documents: Record<string, () => Promise<string>> = {
    repro: () => file(baseSchemes()),
    url: () => file(edited((s) => void (s.petAuth = { type: 'openIdConnect', openIdConnectUrl: loginUrl }))),
    hoba: () => file(edited((s) => void (s.petDigest = { type: 'http', scheme: 'hoba' }))),
    digest: () => file(edited((s) => void (s.petDigest = { type: 'http', scheme: 'digest' }))),
    dropped: () => file(edited((s) => void delete s.petAuth)),
    added: () => file({ ...baseSchemes(), petLogin: { type: 'openIdConnect', openIdConnectUrl: oidcUrl } }),
    apikey: () => file(replacingPetAuth({ petAuth: apiKey })),
    'added-apikey': () => file({ ...baseSchemes(), petLogin: apiKey }),
    renamed: () => file(replacingPetAuth({ petOidc: { type: 'openIdConnect', openIdConnectUrl: oidcUrl } }), 'petOidc'),
    'apikey-renamed': () => file(replacingPetAuth({ petOidc: apiKey }), 'petOidc'),
  };

  describe('every command the issue lists, through diffCommand', () => {
    const commands: Array<[string, string, 0 | 1 | 2, string[]]> = [
      // The four the issue lists as exit 0 today.
      ['repro', 'url', 2, ['security-scheme-modified petAuth breaking']],
      ['repro', 'hoba', 2, ['security-scheme-modified petDigest breaking']],
      ['repro', 'dropped', 2, ['security-scheme-removed petAuth breaking']],
      ['repro', 'added', 1, ['security-scheme-added petLogin additive']],
      // `Digest` → `digest` is no change, as `Bearer` → `bearer` is none.
      ['repro', 'digest', 0, []],
      ['digest', 'repro', 0, []],
      // A changed kind is a modified scheme, not an added or a removed one.
      ['repro', 'apikey', 2, ['security-scheme-modified petAuth breaking']],
      ['apikey', 'repro', 2, ['security-scheme-modified petAuth breaking']],
      // The reverses.
      ['url', 'repro', 2, ['security-scheme-modified petAuth breaking']],
      ['hoba', 'repro', 2, ['security-scheme-modified petDigest breaking']],
      ['added', 'repro', 1, ['security-scheme-removed petLogin additive']],
      // The issue's apiKey controls give what they gave.
      ['apikey', 'dropped', 2, ['security-scheme-removed petAuth breaking']],
      ['repro', 'added-apikey', 1, ['security-scheme-added petLogin additive']],
    ];

    it.each(commands)('oagen diff --old %s.json --new %s.json exits %i', async (old, next, exit, changes) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const err: unknown = await diffCommand({ old: await documents[old](), new: await documents[next]() }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ exitCode: exit });
      const printed = JSON.parse(log.mock.calls[0][0] as string) as DiffReport;
      expect(summarized(printed)).toEqual(changes);
      // Every scheme is read, so nothing is warned about.
      expect(warn).not.toHaveBeenCalled();
    });

    it('a rename with its requirements is an added and a removed scheme beside the requirement changes, as an apiKey’s is', async () => {
      const expected = [
        'security-scheme-added petOidc additive',
        'security-scheme-removed petAuth breaking',
        'operation-modified listPets breaking',
        'callback-modified petAdopted breaking',
      ];
      const renamed = diffSpecs(await parseSpec(await documents.repro()), await parseSpec(await documents.renamed()));
      expect(summarized(renamed)).toEqual(expected);
      expect(exitCode(renamed)).toBe(2);
      const control = diffSpecs(
        await parseSpec(await documents.apikey()),
        await parseSpec(await documents['apikey-renamed']()),
      );
      expect(summarized(control)).toEqual(expected);
    });
  });

  describe('a changed definition is security-scheme-modified, breaking in use', () => {
    it('url.json: petAuth’s openIdConnectUrl changed, exit 2, in either direction', async () => {
      const before = await parse(baseSchemes());
      const after = await parse(
        edited((s) => void (s.petAuth = { type: 'openIdConnect', openIdConnectUrl: loginUrl })),
      );
      expect(schemesInUse(after)).toContain('petAuth');

      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        {
          kind: 'security-scheme-modified',
          schemeName: 'petAuth',
          oldScheme: petAuth,
          newScheme: petAuthMoved,
          details: `openIdConnectUrl "${oidcUrl}" → "${loginUrl}"`,
          classification: 'breaking',
        },
      ]);
      expect(diff.behaviorChanges).toEqual([
        {
          kind: 'security-scheme-changed',
          schemeName: 'petAuth',
          oldScheme: petAuth,
          newScheme: petAuthMoved,
          classification: 'breaking',
        },
      ]);
      expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1, breaking: 1, additive: 0, behaviorChanges: 1 });
      expect(exitCode(diff)).toBe(2);

      const reverse = diffSpecs(after, before);
      expect(reverse.changes).toMatchObject([
        { kind: 'security-scheme-modified', details: `openIdConnectUrl "${loginUrl}" → "${oidcUrl}"` },
      ]);
      expect(exitCode(reverse)).toBe(2);
    });

    it('hoba.json: petDigest’s scheme Digest → hoba, exit 2, in either direction', async () => {
      const before = await parse(baseSchemes());
      const after = await parse(edited((s) => void (s.petDigest = { type: 'http', scheme: 'hoba' })));

      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        {
          kind: 'security-scheme-modified',
          schemeName: 'petDigest',
          oldScheme: petDigest,
          newScheme: petHoba,
          details: 'http Digest → http hoba',
          classification: 'breaking',
        },
      ]);
      expect(exitCode(diff)).toBe(2);

      const reverse = diffSpecs(after, before);
      expect(reverse.changes).toMatchObject([{ kind: 'security-scheme-modified', details: 'http hoba → http Digest' }]);
      expect(exitCode(reverse)).toBe(2);
    });

    it.each(['digest', 'DIGEST', 'dIgEsT'])(
      'Digest → %s is no change, exit 0, in either direction, though the IR keeps each spelling',
      async (spelling) => {
        const before = await parse(baseSchemes());
        const after = await parse(edited((s) => void (s.petDigest = { type: 'http', scheme: spelling })));
        expect(after.auth).toContainEqual({ kind: 'http', schemeName: 'petDigest', scheme: spelling });
        for (const [a, b] of [
          [before, after],
          [after, before],
        ]) {
          const diff = diffSpecs(a, b);
          expect(diff.changes).toEqual([]);
          expect(diff.behaviorChanges).toEqual([]);
          expect(exitCode(diff)).toBe(0);
        }
      },
    );

    it('apikey.json: openIdConnect → apiKey is one breaking security-scheme-modified, not an added scheme', async () => {
      const before = await parse(baseSchemes());
      const after = await parse(replacingPetAuth({ petAuth: apiKey }));

      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        {
          kind: 'security-scheme-modified',
          schemeName: 'petAuth',
          oldScheme: petAuth,
          newScheme: petAuthKey,
          details: 'openIdConnect → apiKey',
          classification: 'breaking',
        },
      ]);
      expect(exitCode(diff)).toBe(2);

      const reverse = diffSpecs(after, before);
      expect(reverse.changes).toMatchObject([
        { kind: 'security-scheme-modified', details: 'apiKey → openIdConnect', classification: 'breaking' },
      ]);
      expect(exitCode(reverse)).toBe(2);
    });

    const kindChanges: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
      ['http digest → apiKey', { type: 'http', scheme: 'digest' }, apiKey, 'http digest → apiKey'],
      [
        'http Digest → http bearer',
        { type: 'http', scheme: 'Digest' },
        { type: 'http', scheme: 'bearer' },
        'http Digest → http bearer',
      ],
      [
        'http basic → http Negotiate',
        { type: 'http', scheme: 'basic' },
        { type: 'http', scheme: 'Negotiate' },
        'http basic → http Negotiate',
      ],
      [
        'openIdConnect → oauth2',
        { type: 'openIdConnect', openIdConnectUrl: oidcUrl },
        { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: {} } } },
        'openIdConnect → oauth2',
      ],
      [
        'openIdConnect → http digest',
        { type: 'openIdConnect', openIdConnectUrl: oidcUrl },
        { type: 'http', scheme: 'digest' },
        'openIdConnect → http digest',
      ],
      ['mutualTLS → apiKey', { type: 'mutualTLS' }, apiKey, 'mutualTLS → apiKey'],
      ['mutualTLS → http bearer', { type: 'mutualTLS' }, { type: 'http', scheme: 'bearer' }, 'mutualTLS → http bearer'],
      [
        'mutualTLS → openIdConnect',
        { type: 'mutualTLS' },
        { type: 'openIdConnect', openIdConnectUrl: oidcUrl },
        'mutualTLS → openIdConnect',
      ],
    ];

    it.each(kindChanges)(
      '%s under a requirement is breaking, exit 2; on a scheme nothing uses, additive, exit 1',
      async (_label, from, to, details) => {
        const inUse = diffSpecs(
          await parse(replacingPetAuth({ petAuth: from })),
          await parse(replacingPetAuth({ petAuth: to })),
        );
        expect(inUse.changes).toMatchObject([
          { kind: 'security-scheme-modified', schemeName: 'petAuth', details, classification: 'breaking' },
        ]);
        expect(exitCode(inUse)).toBe(2);

        // `petToken` is declared and named by nothing.
        const unused = diffSpecs(
          await parse(edited((s) => void (s.petToken = from))),
          await parse(edited((s) => void (s.petToken = to))),
        );
        expect(unused.changes).toMatchObject([
          { kind: 'security-scheme-modified', schemeName: 'petToken', details, classification: 'additive' },
        ]);
        expect(exitCode(unused)).toBe(1);
      },
    );
  });

  describe('a scheme added or removed', () => {
    it('dropped.json: petAuth removed while listPets and petAdopted still name it is breaking, exit 2', async () => {
      const before = await parse(baseSchemes());
      const after = await parse(edited((s) => void delete s.petAuth));
      // The requirements still name it.
      expect(schemesInUse(after)).toContain('petAuth');

      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        { kind: 'security-scheme-removed', schemeName: 'petAuth', scheme: petAuth, classification: 'breaking' },
      ]);
      expect(diff.behaviorChanges).toEqual([
        { kind: 'security-scheme-changed', schemeName: 'petAuth', oldScheme: petAuth, classification: 'breaking' },
      ]);
      expect(exitCode(diff)).toBe(2);
    });

    it('added.json: an openIdConnect petLogin named by nothing is additive, exit 1; removing it again too', async () => {
      const before = await parse(baseSchemes());
      const after = await parse({ ...baseSchemes(), petLogin: { type: 'openIdConnect', openIdConnectUrl: oidcUrl } });

      const diff = diffSpecs(before, after);
      expect(diff.changes).toEqual([
        { kind: 'security-scheme-added', schemeName: 'petLogin', scheme: petLogin, classification: 'additive' },
      ]);
      expect(exitCode(diff)).toBe(1);

      const reverse = diffSpecs(after, before);
      expect(reverse.changes).toEqual([
        { kind: 'security-scheme-removed', schemeName: 'petLogin', scheme: petLogin, classification: 'additive' },
      ]);
      expect(exitCode(reverse)).toBe(1);
    });

    it.each([
      ['http', { type: 'http', scheme: 'Negotiate' }, { kind: 'http', schemeName: 'petLogin', scheme: 'Negotiate' }],
      ['mutualTLS', { type: 'mutualTLS' }, { kind: 'mutualTLS', schemeName: 'petLogin' }],
    ] as Array<[string, Record<string, unknown>, AuthScheme]>)(
      'an unused %s scheme added is additive, exit 1; removed again too',
      async (_kind, definition, scheme) => {
        const before = await parse(baseSchemes());
        const after = await parse({ ...baseSchemes(), petLogin: definition });
        const diff = diffSpecs(before, after);
        expect(diff.changes).toEqual([
          { kind: 'security-scheme-added', schemeName: 'petLogin', scheme, classification: 'additive' },
        ]);
        expect(exitCode(diff)).toBe(1);
        const reverse = diffSpecs(after, before);
        expect(reverse.changes).toEqual([
          { kind: 'security-scheme-removed', schemeName: 'petLogin', scheme, classification: 'additive' },
        ]);
        expect(exitCode(reverse)).toBe(1);
      },
    );

    it('petDigest removed while createPet still names it is breaking, exit 2', async () => {
      const diff = diffSpecs(await parse(baseSchemes()), await parse(edited((s) => void delete s.petDigest)));
      expect(diff.changes).toEqual([
        { kind: 'security-scheme-removed', schemeName: 'petDigest', scheme: petDigest, classification: 'breaking' },
      ]);
      expect(exitCode(diff)).toBe(2);
    });

    // The issue's 3.0.3 document is "without `petCert` and the webhook".
    if (is31) {
      it('petCert removed while the webhook still names it is breaking, exit 2', async () => {
        const before = await parse(baseSchemes());
        expect(schemesInUse(before)).toEqual(new Set(['petAuth', 'petDigest', 'petCert']));
        const diff = diffSpecs(before, await parse(edited((s) => void delete s.petCert)));
        expect(diff.changes).toEqual([
          { kind: 'security-scheme-removed', schemeName: 'petCert', scheme: petCert, classification: 'breaking' },
        ]);
        expect(exitCode(diff)).toBe(2);
      });

      it('petCert becoming an http bearer scheme is a breaking mutualTLS → http bearer, exit 2', async () => {
        const diff = diffSpecs(
          await parse(baseSchemes()),
          await parse(edited((s) => void (s.petCert = { type: 'http', scheme: 'bearer' }))),
        );
        expect(diff.changes).toMatchObject([
          {
            kind: 'security-scheme-modified',
            schemeName: 'petCert',
            oldScheme: petCert,
            details: 'mutualTLS → http bearer',
            classification: 'breaking',
          },
        ]);
        expect(exitCode(diff)).toBe(2);
      });
    }
  });

  describe('what is not a change', () => {
    it('a description or an x-* key on any of the three kinds, exit 0, in either direction', async () => {
      const before = await parse(baseSchemes());
      const after = await parse(
        edited((s) => {
          s.petAuth = { ...s.petAuth, description: 'Log in with the pet store.', 'x-note': 'a' };
          s.petCert = { ...s.petCert, description: 'A client certificate.', 'x-note': 'a' };
          s.petDigest = { ...s.petDigest, description: 'A digest of the password.', 'x-note': 'a' };
        }),
      );
      expect(after.auth?.[0]).toMatchObject({ description: 'Log in with the pet store.' });
      for (const [a, b] of [
        [before, after],
        [after, before],
      ]) {
        const diff = diffSpecs(a, b);
        expect(diff.changes).toEqual([]);
        expect(diff.behaviorChanges).toEqual([]);
        expect(exitCode(diff)).toBe(0);
      }
    });

    it('the same document parsed twice, exit 0', async () => {
      const diff = diffSpecs(await parse(baseSchemes()), await parse(baseSchemes()));
      expect(diff.changes).toEqual([]);
      expect(exitCode(diff)).toBe(0);
    });
  });

  describe('a definition the parser still omits', () => {
    const unreadable: Array<[string, Record<string, unknown>]> = [
      ['an openIdConnect scheme with no openIdConnectUrl', { type: 'openIdConnect' }],
      ['an http scheme with no scheme', { type: 'http' }],
      ['an unknown type', { type: 'saml' }],
    ];

    it.each(unreadable)(
      '%s becoming readable under a name in use is a breaking security-scheme-added, exit 2',
      async (_label, definition) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const before = await parse(replacingPetAuth({ petAuth: definition }));
        const after = await parse(baseSchemes());
        expect(before.auth?.map((scheme) => scheme.schemeName)).not.toContain('petAuth');
        expect(schemesInUse(before)).toContain('petAuth');

        const diff = diffSpecs(before, after);
        expect(diff.changes).toEqual([
          { kind: 'security-scheme-added', schemeName: 'petAuth', scheme: petAuth, classification: 'breaking' },
        ]);
        expect(exitCode(diff)).toBe(2);

        const reverse = diffSpecs(after, before);
        expect(reverse.changes).toEqual([
          { kind: 'security-scheme-removed', schemeName: 'petAuth', scheme: petAuth, classification: 'breaking' },
        ]);
        expect(exitCode(reverse)).toBe(2);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// The differ alone, over hand-built IR.
// ---------------------------------------------------------------------------

const petReturned: Webhook = {
  name: 'petReturned',
  httpMethod: 'post',
  headerParams: [],
  queryParams: [],
  requestBody: { kind: 'primitive', type: 'string' },
  responses: [{ statusCode: 200 }],
};

/** A document whose one webhook inherits a default requiring every scheme in `inUse`. */
function spec(auth: AuthScheme[], inUse: string[] = auth.map((scheme) => scheme.schemeName)): ApiSpec {
  return {
    name: 'Pets',
    version: '1',
    baseUrl: 'https://api.example.com',
    services: [],
    models: [],
    enums: [],
    sdk: defaultSdkBehavior(),
    auth,
    security: [inUse.map((schemeName) => ({ schemeName, scopes: [] }))],
    webhooks: [petReturned],
  };
}

describe('#662 — diffAuthSchemes over the three kinds', () => {
  const oidc = (openIdConnectUrl: string): AuthScheme => ({ kind: 'openIdConnect', schemeName: 's', openIdConnectUrl });
  const http = (scheme: string): AuthScheme => ({ kind: 'http', schemeName: 's', scheme });
  const mtls: AuthScheme = { kind: 'mutualTLS', schemeName: 's' };

  it('two mutualTLS schemes carry nothing but their kind, so they never differ', () => {
    expect(diffAuthSchemes(spec([mtls]), spec([{ ...mtls, description: 'A client certificate.' }]))).toEqual([]);
  });

  it('an openIdConnectUrl is compared as written, as an oauth2 flow’s tokenUrl is', () => {
    const oauth = (tokenUrl: string): AuthScheme => ({
      kind: 'oauth2',
      schemeName: 's',
      flows: { clientCredentials: { tokenUrl, scopes: {} } },
    });
    expect(diffAuthSchemes(spec([oidc(oidcUrl)]), spec([oidc(oidcUrl)]))).toEqual([]);
    // The control: #384 compares a flow's URLs as written too.
    expect(diffAuthSchemes(spec([oauth(oidcUrl)]), spec([oauth(oidcUrl.toUpperCase())]))).toMatchObject([
      { kind: 'security-scheme-modified', details: 'oauth2 flows changed', classification: 'breaking' },
    ]);
    for (const moved of [`${oidcUrl}/`, oidcUrl.toUpperCase(), ` ${oidcUrl}`, oidcUrl.replace('https', 'http')]) {
      expect(diffAuthSchemes(spec([oidc(oidcUrl)]), spec([oidc(moved)]))).toMatchObject([
        {
          kind: 'security-scheme-modified',
          details: `openIdConnectUrl "${oidcUrl}" → "${moved}"`,
          classification: 'breaking',
        },
      ]);
    }
  });

  it('an http scheme name is compared case-insensitively, and reported as written', () => {
    expect(diffAuthSchemes(spec([http('Digest')]), spec([http('DIGEST')]))).toEqual([]);
    expect(diffAuthSchemes(spec([http('SCRAM-SHA-256')]), spec([http('scram-sha-256')]))).toEqual([]);
    expect(diffAuthSchemes(spec([http('SCRAM-SHA-1')]), spec([http('SCRAM-SHA-256')]))).toMatchObject([
      {
        kind: 'security-scheme-modified',
        details: 'http SCRAM-SHA-1 → http SCRAM-SHA-256',
        classification: 'breaking',
      },
    ]);
  });

  it('reads the http family by scheme name, so an http entry spelled basic or bearer is that kind', () => {
    // The parser never writes these — `basic` and `bearer` are their own
    // kinds — but an `ApiSpec` built by hand may.
    expect(diffAuthSchemes(spec([http('Bearer')]), spec([{ kind: 'bearer', schemeName: 's' }]))).toEqual([]);
    expect(diffAuthSchemes(spec([{ kind: 'basic', schemeName: 's' }]), spec([http('BASIC')]))).toEqual([]);
    expect(diffAuthSchemes(spec([http('basic')]), spec([{ kind: 'bearer', schemeName: 's' }]))).toMatchObject([
      { kind: 'security-scheme-modified', details: 'http basic → http bearer', classification: 'breaking' },
    ]);
  });

  it('a changed definition on a scheme no request carries is additive', () => {
    expect(diffAuthSchemes(spec([oidc(oidcUrl)], []), spec([oidc(loginUrl)], []))).toMatchObject([
      { kind: 'security-scheme-modified', classification: 'additive' },
    ]);
    expect(diffAuthSchemes(spec([http('digest')], []), spec([http('hoba')], []))).toMatchObject([
      { kind: 'security-scheme-modified', classification: 'additive' },
    ]);
    expect(diffAuthSchemes(spec([mtls], []), spec([http('digest')], []))).toMatchObject([
      { kind: 'security-scheme-modified', details: 'mutualTLS → http digest', classification: 'additive' },
    ]);
  });
});
