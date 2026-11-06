import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import type { ApiSpec } from '../../src/ir/types.js';

/**
 * Covers `extractAuthSchemes` in parse.ts: how `components.securitySchemes`
 * becomes `ApiSpec.auth`.
 */
describe('parseSpec — security schemes', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-parse-auth-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Write `content` to a temp YAML spec file and parse it. */
  async function parseYaml(content: string): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.yml');
    await fs.writeFile(specFile, content, 'utf-8');
    return parseSpec(specFile);
  }

  it('carries schemeName and description so Operation.security joins to spec.auth (#177)', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
paths:
  /one:
    get:
      operationId: getOne
      security: [{ userToken: [] }]
      responses: { '204': { description: ok } }
  /two:
    get:
      operationId: getTwo
      security: [{ partnerKey: [] }]
      responses: { '204': { description: ok } }
  /three:
    get:
      operationId: getThree
      security: [{ serviceToken: [] }]
      responses: { '204': { description: ok } }
components:
  securitySchemes:
    userToken:
      type: http
      scheme: bearer
      description: A token issued to a user.
    partnerKey:
      type: apiKey
      in: header
      name: X-Partner-Key
    serviceToken:
      type: http
      scheme: bearer
      description: A token issued to a service.
`);

    // Document order is preserved; the two bearer schemes are distinguishable by name.
    expect(ir.auth).toEqual([
      { kind: 'bearer', schemeName: 'userToken', description: 'A token issued to a user.' },
      { kind: 'apiKey', schemeName: 'partnerKey', in: 'header', name: 'X-Partner-Key' },
      { kind: 'bearer', schemeName: 'serviceToken', description: 'A token issued to a service.' },
    ]);
    // `description` is omitted (not set to undefined) when the document has none.
    expect(Object.keys(ir.auth![1])).not.toContain('description');

    // Every per-operation requirement resolves to a scheme by schemeName.
    const operations = ir.services.flatMap((s) => s.operations);
    expect(operations).toHaveLength(3);
    for (const op of operations) {
      expect(op.security, `${op.name} has security`).toBeDefined();
      for (const requirement of op.security!.flat()) {
        const scheme = ir.auth!.find((a) => a.schemeName === requirement.schemeName);
        expect(scheme, `${op.name} references ${requirement.schemeName}`).toBeDefined();
      }
    }
    const byName = Object.fromEntries(operations.map((op) => [op.name, op.security!.flat().map((r) => r.schemeName)]));
    expect(byName).toEqual({ getOne: ['userToken'], getTwo: ['partnerKey'], getThree: ['serviceToken'] });
  });

  it('carries schemeName and description on oauth2 schemes', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
paths: {}
components:
  securitySchemes:
    oauth:
      type: oauth2
      description: OAuth 2.0 client credentials.
      flows:
        clientCredentials:
          tokenUrl: https://auth.example.com/token
          scopes:
            read: Read access
`);

    expect(ir.auth).toEqual([
      {
        kind: 'oauth2',
        schemeName: 'oauth',
        description: 'OAuth 2.0 client credentials.',
        flows: { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: { read: 'Read access' } } },
      },
    ]);
  });

  it('keeps an explicitly empty description distinct from a missing one', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
paths: {}
components:
  securitySchemes:
    emptyDesc:
      type: http
      scheme: bearer
      description: ''
    noDesc:
      type: http
      scheme: bearer
`);

    expect(ir.auth).toEqual([
      { kind: 'bearer', schemeName: 'emptyDesc', description: '' },
      { kind: 'bearer', schemeName: 'noDesc' },
    ]);
    // `toEqual` treats `description: undefined` as absent, so pin the key itself.
    expect(ir.auth![0]).toHaveProperty('description', '');
    expect(ir.auth![1]).not.toHaveProperty('description');
  });

  it('accepts HTTP basic and case-insensitive bearer schemes (#176)', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
paths:
  /thing:
    get:
      operationId: getThing
      responses: { '204': { description: ok } }
components:
  securitySchemes:
    basicAuth:
      type: http
      scheme: basic
    bearerAuth:
      type: http
      scheme: Bearer
`);

    expect(ir.auth).toEqual([
      { kind: 'basic', schemeName: 'basicAuth' },
      { kind: 'bearer', schemeName: 'bearerAuth' },
    ]);
  });

  it('matches HTTP scheme names case-insensitively (RFC 9110 §11.1)', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
paths: {}
components:
  securitySchemes:
    upper:
      type: http
      scheme: BEARER
    mixed:
      type: http
      scheme: BaSiC
`);

    expect(ir.auth).toEqual([
      { kind: 'bearer', schemeName: 'upper' },
      { kind: 'basic', schemeName: 'mixed' },
    ]);
  });

  it('warns about and omits security schemes the IR cannot represent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
paths: {}
components:
  securitySchemes:
    digestAuth:
      type: http
      scheme: digest
    oidc:
      type: openIdConnect
      openIdConnectUrl: https://auth.example.com/.well-known/openid-configuration
    mtls:
      type: mutualTLS
    bearerAuth:
      type: http
      scheme: bearer
`);

      // Supported schemes still come through; unsupported ones are dropped.
      expect(ir.auth).toEqual([{ kind: 'bearer', schemeName: 'bearerAuth' }]);

      // One diagnostic per unsupported scheme, naming the scheme and its type.
      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(messages).toHaveLength(3);
      for (const message of messages) expect(message).toContain('[oagen] Warning:');
      expect(messages[0]).toContain('"digestAuth"');
      expect(messages[0]).toContain('digest');
      expect(messages[1]).toContain('"oidc"');
      expect(messages[1]).toContain('openIdConnect');
      expect(messages[2]).toContain('"mtls"');
      expect(messages[2]).toContain('mutualTLS');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * #384 review (MichaelDeBoey): an entry under `components.securitySchemes`
 * may be a `$ref` to another entry — OAS 3.0.3 and 3.1.0 both allow it.
 * The parser follows it, chains included, through `followReference`, and
 * reads the scheme under the referencing key with the target's definition,
 * so a requirement naming the referencing key joins to a scheme and the
 * differ sees what every request carries.
 */
describe('parseSpec — a $ref under components.securitySchemes (#384)', () => {
  let tmpDir: string;
  let written = 0;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-parse-auth-ref-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** `GET /pets` under `security: [{ petKey: [] }]` with the given `components`. */
  async function parseDocument(
    openapi: string,
    securitySchemes: Record<string, unknown>,
    components: Record<string, unknown> = {},
  ): Promise<ApiSpec> {
    const file = path.join(tmpDir, `${written++}.json`);
    await fs.writeFile(
      file,
      JSON.stringify({
        openapi,
        info: { title: 'repro', version: '1' },
        security: [{ petKey: [] }],
        paths: { '/pets': { get: { operationId: 'listPets', responses: { '204': { description: 'ok' } } } } },
        components: { securitySchemes, ...components },
      }),
    );
    return parseSpec(file);
  }

  const versions = ['3.0.3', '3.1.0'];
  const sharedKey = { type: 'apiKey', in: 'header', name: 'X-Key' };
  const ref = (name: string) => ({ $ref: `#/components/securitySchemes/${name}` });

  it.each(versions)(
    'on OAS %s reads the scheme under the referencing key with the target’s definition, in document order',
    async (openapi) => {
      const ir = await parseDocument(openapi, { petKey: ref('sharedKey'), sharedKey });
      expect(ir.auth).toEqual([
        { kind: 'apiKey', schemeName: 'petKey', in: 'header', name: 'X-Key' },
        { kind: 'apiKey', schemeName: 'sharedKey', in: 'header', name: 'X-Key' },
      ]);
      // The document's requirement joins to the referencing key.
      expect(ir.security).toEqual([[{ schemeName: 'petKey', scopes: [] }]]);
    },
  );

  it.each(versions)('on OAS %s follows a chain, and reads every kind through a ref', async (openapi) => {
    const ir = await parseDocument(openapi, {
      petKey: ref('alias'),
      alias: ref('sharedKey'),
      sharedKey,
      token: ref('bearer'),
      bearer: { type: 'http', scheme: 'bearer', description: 'A token.' },
      oauth: ref('oauthShared'),
      oauthShared: {
        type: 'oauth2',
        flows: { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: {} } },
      },
    });
    expect(ir.auth?.map((a) => a.schemeName)).toEqual([
      'petKey',
      'alias',
      'sharedKey',
      'token',
      'bearer',
      'oauth',
      'oauthShared',
    ]);
    expect(ir.auth?.[0]).toEqual({ kind: 'apiKey', schemeName: 'petKey', in: 'header', name: 'X-Key' });
    expect(ir.auth?.[1]).toEqual({ kind: 'apiKey', schemeName: 'alias', in: 'header', name: 'X-Key' });
    expect(ir.auth?.[3]).toEqual({ kind: 'bearer', schemeName: 'token', description: 'A token.' });
    expect(ir.auth?.[5]).toEqual({
      kind: 'oauth2',
      schemeName: 'oauth',
      flows: { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: {} } },
    });
  });

  it('reads a description beside the $ref over the target’s on OAS 3.1.0, and ignores it on 3.0.3', async () => {
    const schemes = {
      petKey: { ...ref('sharedKey'), description: 'The pet key.' },
      sharedKey: { ...sharedKey, description: 'The shared key.' },
    };
    const overriding = await parseDocument('3.1.0', schemes);
    expect(overriding.auth?.[0]).toEqual({
      kind: 'apiKey',
      schemeName: 'petKey',
      description: 'The pet key.',
      in: 'header',
      name: 'X-Key',
    });
    const ignoring = await parseDocument('3.0.3', schemes);
    expect(ignoring.auth?.[0]).toEqual({
      kind: 'apiKey',
      schemeName: 'petKey',
      description: 'The shared key.',
      in: 'header',
      name: 'X-Key',
    });
    // A blank sibling is no text and falls through to the target's.
    const blank = await parseDocument('3.1.0', {
      petKey: { ...ref('sharedKey'), description: '  ' },
      sharedKey: { ...sharedKey, description: 'The shared key.' },
    });
    expect(blank.auth?.[0].description).toBe('The shared key.');
  });

  it.each(versions)(
    'on OAS %s omits a ref the map does not answer with the unsupported-scheme warning, naming the ref',
    async (openapi) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const ir = await parseDocument(
          openapi,
          {
            // A pointer into another section: the bundle resolves it, the
            // map does not answer it (the whole pointer is matched).
            petKey: { $ref: '#/components/schemas/Pet' },
            sharedKey,
          },
          { schemas: { Pet: { type: 'object' } } },
        );
        expect(ir.auth).toEqual([{ kind: 'apiKey', schemeName: 'sharedKey', in: 'header', name: 'X-Key' }]);
        expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
          '[oagen] Warning: Unsupported security scheme "petKey" ($ref #/components/schemas/Pet unresolved) omitted from spec.auth',
        ]);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each(versions)(
    'on OAS %s fails the bundle on a ref that names no scheme at all, or a cycle of refs, as any dangling ref does',
    async (openapi) => {
      await expect(parseDocument(openapi, { petKey: ref('missing') })).rejects.toThrow(/Failed to parse spec/);
      // The bundler follows a `$ref` whose target is itself a `$ref` and
      // throws on the cycle before the parser sees the document.
      await expect(parseDocument(openapi, { petKey: ref('alias'), alias: ref('petKey') })).rejects.toThrow(/circular/i);
    },
  );
});
