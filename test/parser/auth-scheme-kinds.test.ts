/**
 * Issue #662: `ApiSpec.auth` carries every Security Scheme Object the
 * document declares well-formed — `openIdConnect` with its
 * `openIdConnectUrl`, `mutualTLS`, and an `http` scheme other than `basic`
 * and `bearer` with its `scheme` as written — so a requirement naming one
 * joins to a definition. The `Unsupported security scheme … omitted from
 * spec.auth` warning is left for what still has no representation: an
 * entry that is no object, an unknown `type`, or a definition missing the
 * field its type requires.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec, AuthScheme, Callback, SecurityRequirementSet } from '../../src/ir/types.js';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

let written = 0;
async function parse(doc: unknown): Promise<ApiSpec> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-auth-scheme-kinds-'));
  dirs.push(dir);
  const file = path.join(dir, `${written++}.json`);
  await fs.writeFile(file, JSON.stringify(doc));
  return parseSpec(file);
}

/** Every `console.warn` line a parse printed. */
function warnings(): string[] {
  return vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
}

const oidcUrl = 'https://auth.example.com/.well-known/openid-configuration';
const json = (schema: unknown) => ({ 'application/json': { schema } });
const petId = { type: 'object', properties: { petId: { type: 'string' } } };

/**
 * The issue's `repro.json`: `GET /pets` (listPets) requiring `petAuth` with
 * `read:pets`, `POST /pets` (createPet) requiring `petDigest` with a
 * callback `petAdopted` requiring `petAuth` with `write:pets`, and on 3.1 a
 * webhook `petReturned` requiring `petCert`. The 3.0.3 copy is "without
 * `petCert` and the webhook".
 */
function issueDocument(openapi: string) {
  const is31 = openapi.startsWith('3.1');
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          security: [{ petAuth: ['read:pets'] }],
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
                  security: [{ petAuth: ['write:pets'] }],
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
    components: {
      securitySchemes: {
        petAuth: { type: 'openIdConnect', openIdConnectUrl: oidcUrl },
        ...(is31 ? { petCert: { type: 'mutualTLS' } } : {}),
        petDigest: { type: 'http', scheme: 'Digest' },
        petToken: { type: 'http', scheme: 'Bearer' },
      },
    },
  };
}

/** Every node that carries a requirement list, as the issue's script collects them. */
function securedNodes(ir: ApiSpec): Array<{ name: string; security?: SecurityRequirementSet[] }> {
  const operations = ir.services.flatMap((service) => service.operations);
  const callbacks: Callback[] = operations.flatMap((op) => op.callbacks ?? []);
  return [...operations, ...callbacks, ...(ir.webhooks ?? [])];
}

/** `GET /pets` under a document default naming `petAuth`, declared as `definition`. */
function single(openapi: string, definition: unknown, more: Record<string, unknown> = {}) {
  return {
    openapi,
    info: { title: 'repro', version: '1' },
    security: [{ petAuth: [] }],
    paths: { '/pets': { get: { operationId: 'listPets', responses: { '204': { description: 'ok' } } } } },
    components: { securitySchemes: { petAuth: definition, ...more } },
  };
}

const versions = ['3.0.3', '3.1.0'];

describe('#662 — openIdConnect, mutualTLS and every http scheme in spec.auth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the issue’s repro', () => {
    it('on OAS 3.1.0 carries the four schemes in document order, without a warning, and every requirement joins to one', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ir = await parse(issueDocument('3.1.0'));
      expect(ir.auth).toEqual([
        { kind: 'openIdConnect', schemeName: 'petAuth', openIdConnectUrl: oidcUrl },
        { kind: 'mutualTLS', schemeName: 'petCert' },
        { kind: 'http', schemeName: 'petDigest', scheme: 'Digest' },
        { kind: 'bearer', schemeName: 'petToken' },
      ]);
      // The issue's script, line for line: the requirements keep their lists.
      expect(securedNodes(ir).map(({ name, security }) => `${name}: ${JSON.stringify(security)}`)).toEqual([
        'listPets: [[{"schemeName":"petAuth","scopes":["read:pets"]}]]',
        'createPet: [[{"schemeName":"petDigest","scopes":[]}]]',
        'petAdopted: [[{"schemeName":"petAuth","scopes":["write:pets"]}]]',
        'petReturned: [[{"schemeName":"petCert","scopes":[]}]]',
      ]);
      expect(warnings()).toEqual([]);
      // No `schemeName` joins to nothing.
      for (const node of securedNodes(ir)) {
        for (const requirement of (node.security ?? []).flat()) {
          expect(
            ir.auth?.find((scheme) => scheme.schemeName === requirement.schemeName),
            `${node.name} names ${requirement.schemeName}`,
          ).toBeDefined();
        }
      }
    });

    it('on OAS 3.0.3 (without petCert and the webhook) gives the same for the other three', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ir = await parse(issueDocument('3.0.3'));
      expect(ir.auth).toEqual([
        { kind: 'openIdConnect', schemeName: 'petAuth', openIdConnectUrl: oidcUrl },
        { kind: 'http', schemeName: 'petDigest', scheme: 'Digest' },
        { kind: 'bearer', schemeName: 'petToken' },
      ]);
      expect(securedNodes(ir).map(({ name, security }) => `${name}: ${JSON.stringify(security)}`)).toEqual([
        'listPets: [[{"schemeName":"petAuth","scopes":["read:pets"]}]]',
        'createPet: [[{"schemeName":"petDigest","scopes":[]}]]',
        'petAdopted: [[{"schemeName":"petAuth","scopes":["write:pets"]}]]',
      ]);
      expect(warnings()).toEqual([]);
    });
  });

  describe.each(versions)('on OAS %s', (openapi) => {
    it('keeps an http scheme as written, and reads basic and bearer in any case as their own kinds', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spellings = ['digest', 'Digest', 'DIGEST', 'HOBA', 'Negotiate', 'SCRAM-SHA-256', 'PrivateToken', 'vapid'];
      const ir = await parse({
        openapi,
        info: { title: 'repro', version: '1' },
        paths: {},
        components: {
          securitySchemes: {
            ...Object.fromEntries(spellings.map((scheme, i) => [`s${i}`, { type: 'http', scheme }])),
            basicUpper: { type: 'http', scheme: 'BASIC' },
            bearerMixed: { type: 'http', scheme: 'BeArEr' },
          },
        },
      });
      expect(ir.auth).toEqual([
        ...spellings.map((scheme, i) => ({ kind: 'http', schemeName: `s${i}`, scheme })),
        { kind: 'basic', schemeName: 'basicUpper' },
        { kind: 'bearer', schemeName: 'bearerMixed' },
      ]);
      // An `http` entry never carries `basic` or `bearer`, in any case.
      const generic = (ir.auth ?? []).filter(
        (scheme): scheme is Extract<AuthScheme, { kind: 'http' }> => scheme.kind === 'http',
      );
      expect(generic.map((scheme) => scheme.scheme.toLowerCase())).not.toContain('basic');
      expect(generic.map((scheme) => scheme.scheme.toLowerCase())).not.toContain('bearer');
      expect(warnings()).toEqual([]);
    });

    it('carries a declared description on each kind, an empty one included, and omits the key otherwise', async () => {
      const ir = await parse({
        openapi,
        info: { title: 'repro', version: '1' },
        paths: {},
        components: {
          securitySchemes: {
            oidc: { type: 'openIdConnect', openIdConnectUrl: oidcUrl, description: 'Log in with the pet store.' },
            cert: { type: 'mutualTLS', description: '' },
            digest: { type: 'http', scheme: 'digest', description: 'A digest of the password.' },
            plain: { type: 'mutualTLS' },
          },
        },
      });
      expect(ir.auth).toEqual([
        {
          kind: 'openIdConnect',
          schemeName: 'oidc',
          description: 'Log in with the pet store.',
          openIdConnectUrl: oidcUrl,
        },
        { kind: 'mutualTLS', schemeName: 'cert', description: '' },
        { kind: 'http', schemeName: 'digest', description: 'A digest of the password.', scheme: 'digest' },
        { kind: 'mutualTLS', schemeName: 'plain' },
      ]);
      expect(ir.auth?.[1]).toHaveProperty('description', '');
      expect(ir.auth?.[3]).not.toHaveProperty('description');
    });

    it('carries nothing but the definition: an x-* key or a bearerFormat beside it is not read', async () => {
      const ir = await parse(
        single(
          openapi,
          { type: 'openIdConnect', openIdConnectUrl: oidcUrl, 'x-note': 'a' },
          {
            cert: { type: 'mutualTLS', 'x-note': 'a' },
            digest: { type: 'http', scheme: 'digest', bearerFormat: 'JWT', 'x-note': 'a' },
          },
        ),
      );
      expect(ir.auth?.map((scheme) => Object.keys(scheme))).toEqual([
        ['kind', 'schemeName', 'openIdConnectUrl'],
        ['kind', 'schemeName'],
        ['kind', 'schemeName', 'scheme'],
      ]);
    });

    it('keeps an openIdConnectUrl exactly as written, a relative one included', async () => {
      const ir = await parse(
        single(
          openapi,
          { type: 'openIdConnect', openIdConnectUrl: '/.well-known/openid-configuration' },
          { padded: { type: 'openIdConnect', openIdConnectUrl: ' https://auth.example.com/x ' } },
        ),
      );
      expect(ir.auth).toEqual([
        { kind: 'openIdConnect', schemeName: 'petAuth', openIdConnectUrl: '/.well-known/openid-configuration' },
        { kind: 'openIdConnect', schemeName: 'padded', openIdConnectUrl: ' https://auth.example.com/x ' },
      ]);
    });

    it('reads each kind through a $ref entry, under the referencing key', async () => {
      const ref = (name: string) => ({ $ref: `#/components/securitySchemes/${name}` });
      const ir = await parse({
        openapi,
        info: { title: 'repro', version: '1' },
        security: [{ petAuth: ['read:pets'] }],
        paths: { '/pets': { get: { operationId: 'listPets', responses: { '204': { description: 'ok' } } } } },
        components: {
          securitySchemes: {
            petAuth: ref('alias'),
            alias: ref('sharedOidc'),
            sharedOidc: { type: 'openIdConnect', openIdConnectUrl: oidcUrl, description: 'Shared.' },
            petCert: { ...ref('sharedCert'), description: 'The pet certificate.' },
            sharedCert: { type: 'mutualTLS' },
            petDigest: ref('sharedDigest'),
            sharedDigest: { type: 'http', scheme: 'Digest' },
          },
        },
      });
      expect(ir.auth).toEqual([
        { kind: 'openIdConnect', schemeName: 'petAuth', description: 'Shared.', openIdConnectUrl: oidcUrl },
        { kind: 'openIdConnect', schemeName: 'alias', description: 'Shared.', openIdConnectUrl: oidcUrl },
        { kind: 'openIdConnect', schemeName: 'sharedOidc', description: 'Shared.', openIdConnectUrl: oidcUrl },
        // Text beside a `$ref` is read on 3.1 and ignored on 3.0, as beside every Reference Object.
        openapi === '3.1.0'
          ? { kind: 'mutualTLS', schemeName: 'petCert', description: 'The pet certificate.' }
          : { kind: 'mutualTLS', schemeName: 'petCert' },
        { kind: 'mutualTLS', schemeName: 'sharedCert' },
        { kind: 'http', schemeName: 'petDigest', scheme: 'Digest' },
        { kind: 'http', schemeName: 'sharedDigest', scheme: 'Digest' },
      ]);
      expect(ir.security).toEqual([[{ schemeName: 'petAuth', scopes: ['read:pets'] }]]);
    });

    it('keeps a requirement’s list as written beside every kind: scopes for openIdConnect, role names for the others', async () => {
      const ir = await parse({
        openapi,
        info: { title: 'repro', version: '1' },
        security: [{ oidc: ['read:pets', 'write:pets'] }, { cert: ['admin'], digest: ['auditor'] }],
        paths: { '/pets': { get: { operationId: 'listPets', responses: { '204': { description: 'ok' } } } } },
        components: {
          securitySchemes: {
            oidc: { type: 'openIdConnect', openIdConnectUrl: oidcUrl },
            cert: { type: 'mutualTLS' },
            digest: { type: 'http', scheme: 'digest' },
          },
        },
      });
      expect(ir.security).toEqual([
        [{ schemeName: 'oidc', scopes: ['read:pets', 'write:pets'] }],
        [
          { schemeName: 'cert', scopes: ['admin'] },
          { schemeName: 'digest', scopes: ['auditor'] },
        ],
      ]);
      expect(ir.auth?.map((scheme) => scheme.kind)).toEqual(['openIdConnect', 'mutualTLS', 'http']);
    });

    it('reads a mutualTLS scheme whichever 3.x version the document declares', async () => {
      // 3.0's Security Scheme Object has no `mutualTLS` type; the parser reads
      // what the document says, as it reads a top-level `webhooks` map there.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ir = await parse(single(openapi, { type: 'mutualTLS' }));
      expect(ir.auth).toEqual([{ kind: 'mutualTLS', schemeName: 'petAuth' }]);
      expect(warnings()).toEqual([]);
    });

    describe('what still has no representation is omitted with the warning, naming what is wrong', () => {
      const unreadable: Array<[string, unknown, string]> = [
        // An `openIdConnect` scheme is its URL.
        [
          'openIdConnect with no openIdConnectUrl',
          { type: 'openIdConnect' },
          'type: openIdConnect, no openIdConnectUrl',
        ],
        [
          'openIdConnect with an empty openIdConnectUrl',
          { type: 'openIdConnect', openIdConnectUrl: '' },
          'type: openIdConnect, openIdConnectUrl: "" is blank',
        ],
        [
          'openIdConnect with a blank openIdConnectUrl',
          { type: 'openIdConnect', openIdConnectUrl: '  ' },
          'type: openIdConnect, openIdConnectUrl: "  " is blank',
        ],
        [
          'openIdConnect with a number for openIdConnectUrl',
          { type: 'openIdConnect', openIdConnectUrl: 5 },
          'type: openIdConnect, openIdConnectUrl: 5 is not a string',
        ],
        [
          'openIdConnect with a null openIdConnectUrl',
          { type: 'openIdConnect', openIdConnectUrl: null },
          'type: openIdConnect, openIdConnectUrl: null is not a string',
        ],
        [
          'openIdConnect with a list for openIdConnectUrl',
          { type: 'openIdConnect', openIdConnectUrl: ['https://auth.example.com/x'] },
          'type: openIdConnect, openIdConnectUrl: ["https://auth.example.com/x"] is not a string',
        ],
        // An `http` scheme is its `scheme`, an RFC 9110 token.
        ['http with no scheme', { type: 'http' }, 'type: http, no scheme'],
        ['http with a null scheme', { type: 'http', scheme: null }, 'type: http, scheme: null is not a token'],
        ['http with an empty scheme', { type: 'http', scheme: '' }, 'type: http, scheme: "" is not a token'],
        ['http with a blank scheme', { type: 'http', scheme: '  ' }, 'type: http, scheme: "  " is not a token'],
        ['http with a number for scheme', { type: 'http', scheme: 5 }, 'type: http, scheme: 5 is not a token'],
        [
          'http with a padded scheme',
          { type: 'http', scheme: ' Bearer ' },
          'type: http, scheme: " Bearer " is not a token',
        ],
        [
          'http with two words for scheme',
          { type: 'http', scheme: 'my scheme' },
          'type: http, scheme: "my scheme" is not a token',
        ],
        [
          'http with a header line for scheme',
          { type: 'http', scheme: 'Digest\r\nX-Injected: 1' },
          'type: http, scheme: "Digest\\r\\nX-Injected: 1" is not a token',
        ],
        // `type` is one of the specification's values, spelled as it spells them.
        ['an unknown type', { type: 'saml' }, 'type: saml'],
        ['type OpenIdConnect', { type: 'OpenIdConnect', openIdConnectUrl: oidcUrl }, 'type: OpenIdConnect'],
        ['type mutualtls', { type: 'mutualtls' }, 'type: mutualtls'],
        ['type HTTP', { type: 'HTTP', scheme: 'digest' }, 'type: HTTP'],
        ['no type', { description: 'Nothing.' }, 'type: undefined'],
        ['a number for type', { type: 5 }, 'type: 5'],
        ['an empty object', {}, 'type: undefined'],
        // The existing kinds keep their checks.
        ['apiKey with no name', { type: 'apiKey', in: 'header' }, 'type: apiKey, no name'],
        ['apiKey with no in', { type: 'apiKey', name: 'X-Key' }, 'type: apiKey, no in'],
        ['apiKey with neither', { type: 'apiKey' }, 'type: apiKey, no in or name'],
        [
          'openIdConnect with a one-space openIdConnectUrl',
          { type: 'openIdConnect', openIdConnectUrl: ' ' },
          'type: openIdConnect, openIdConnectUrl: " " is blank',
        ],
        ['oauth2 with no flows', { type: 'oauth2' }, 'type: oauth2, no flows'],
        // An entry that is no object declares nothing, and is named as JSON.
        ['a null entry', null, 'not a Security Scheme Object: null'],
        ['a string entry', 'bearer', 'not a Security Scheme Object: "bearer"'],
        ['an empty string entry', '', 'not a Security Scheme Object: ""'],
        ['a number entry', 5, 'not a Security Scheme Object: 5'],
        ['a zero entry', 0, 'not a Security Scheme Object: 0'],
        ['a true entry', true, 'not a Security Scheme Object: true'],
        ['a false entry', false, 'not a Security Scheme Object: false'],
        ['an empty array entry', [], 'not a Security Scheme Object: []'],
        [
          'an array of a scheme',
          [{ type: 'http', scheme: 'bearer' }],
          'not a Security Scheme Object: [{"type":"http","scheme":"bearer"}]',
        ],
      ];

      it.each(unreadable)('%s', async (_label, definition, detail) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ir = await parse(single(openapi, definition, { petToken: { type: 'http', scheme: 'bearer' } }));
        // The readable scheme beside it still comes through, and the requirement keeps naming the omitted one.
        expect(ir.auth).toEqual([{ kind: 'bearer', schemeName: 'petToken' }]);
        expect(ir.security).toEqual([[{ schemeName: 'petAuth', scopes: [] }]]);
        expect(warnings()).toEqual([
          `[oagen] Warning: Unsupported security scheme "petAuth" (${detail}) omitted from spec.auth`,
        ]);
      });

      // A `$ref` entry is a Reference Object: it is followed, and what it
      // lands on is read under the referencing key.
      it('a $ref entry is read under its own key with the target’s definition', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ir = await parse(
          single(
            openapi,
            { $ref: '#/components/securitySchemes/Other' },
            { Other: { type: 'apiKey', in: 'header', name: 'X-Key' } },
          ),
        );
        expect(ir.auth).toEqual([
          { kind: 'apiKey', schemeName: 'petAuth', in: 'header', name: 'X-Key' },
          { kind: 'apiKey', schemeName: 'Other', in: 'header', name: 'X-Key' },
        ]);
        expect(warnings()).toEqual([]);
      });

      const nonObjects: Array<[string, unknown, string]> = [
        ['null', null, 'null'],
        ['a string', 'bearer', '"bearer"'],
        ['a number', 5, '5'],
        ['true', true, 'true'],
        ['false', false, 'false'],
        ['an array', [], '[]'],
      ];

      it.each(nonObjects)(
        'a $ref entry landing on %s is omitted naming what it found, beside that entry’s own warning',
        async (_label, target, json) => {
          vi.spyOn(console, 'warn').mockImplementation(() => {});
          const ir = await parse(
            single(
              openapi,
              { $ref: '#/components/securitySchemes/Other' },
              { Other: target, petToken: { type: 'http', scheme: 'bearer' } },
            ),
          );
          expect(ir.auth).toEqual([{ kind: 'bearer', schemeName: 'petToken' }]);
          expect(warnings()).toEqual([
            `[oagen] Warning: Unsupported security scheme "petAuth" ($ref #/components/securitySchemes/Other is not a Security Scheme Object: ${json}) omitted from spec.auth`,
            `[oagen] Warning: Unsupported security scheme "Other" (not a Security Scheme Object: ${json}) omitted from spec.auth`,
          ]);
        },
      );

      it('a chain of $refs landing on an entry that is no object names the ref the walk stopped at', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ir = await parse(
          single(
            openapi,
            { $ref: '#/components/securitySchemes/alias' },
            { alias: { $ref: '#/components/securitySchemes/Other' }, Other: null },
          ),
        );
        expect(ir.auth).toBeUndefined();
        expect(warnings()).toEqual([
          '[oagen] Warning: Unsupported security scheme "petAuth" ($ref #/components/securitySchemes/Other is not a Security Scheme Object: null) omitted from spec.auth',
          '[oagen] Warning: Unsupported security scheme "alias" ($ref #/components/securitySchemes/Other is not a Security Scheme Object: null) omitted from spec.auth',
          '[oagen] Warning: Unsupported security scheme "Other" (not a Security Scheme Object: null) omitted from spec.auth',
        ]);
      });

      it('a $ref that is not a string, or points into another section, keeps its warning', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ir = await parse({
          openapi,
          info: { title: 'repro', version: '1' },
          paths: {},
          components: {
            securitySchemes: {
              numbered: { $ref: 5 },
              elsewhere: { $ref: '#/components/schemas/Pet' },
            },
            schemas: { Pet: { type: 'object' } },
          },
        });
        expect(ir.auth).toBeUndefined();
        expect(warnings()).toEqual([
          '[oagen] Warning: Unsupported security scheme "numbered" ($ref 5 malformed) omitted from spec.auth',
          '[oagen] Warning: Unsupported security scheme "elsewhere" ($ref #/components/schemas/Pet unresolved) omitted from spec.auth',
        ]);
      });

      it('leaves auth undefined when no entry is readable', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ir = await parse(single(openapi, { type: 'http' }));
        expect(ir.auth).toBeUndefined();
      });
    });
  });
});
