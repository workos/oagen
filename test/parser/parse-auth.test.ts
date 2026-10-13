import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
      for (const requirement of op.security!) {
        const scheme = ir.auth!.find((a) => a.schemeName === requirement.schemeName);
        expect(scheme, `${op.name} references ${requirement.schemeName}`).toBeDefined();
      }
    }
    const byName = Object.fromEntries(operations.map((op) => [op.name, op.security!.map((r) => r.schemeName)]));
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
});
