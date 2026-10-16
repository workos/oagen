import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSpec } from '../../src/parser/parse.js';
import { resolveServerUrl } from '../../src/ir/server-url.js';
import type { ApiSpec } from '../../src/ir/types.js';

/**
 * Covers `extractServers` in servers.ts: how the document's `servers` list
 * becomes `ApiSpec.servers` and `ApiSpec.baseUrl`, server variables included.
 */
describe('parseSpec — servers', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-parse-servers-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Write `content` to a temp YAML spec file and parse it. */
  async function parseYaml(content: string): Promise<ApiSpec> {
    const specFile = path.join(tmpDir, 'spec.yml');
    await fs.writeFile(specFile, content, 'utf-8');
    return parseSpec(specFile);
  }

  /** Every `[oagen] Warning:` the parse emitted. */
  function warnings(): string[] {
    const messages = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    for (const message of messages) expect(message).toContain('[oagen] Warning:');
    return messages;
  }

  const minimalPaths = `
paths:
  /pets:
    get:
      operationId: listPets
      responses: { '204': { description: ok } }
`;

  it('keeps server variables and fills their defaults into baseUrl (#216)', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://{region}.api.example.com/v1
    description: Regional API
    variables:
      region:
        default: eu
        enum: [eu, us]
        description: The region the account lives in.
${minimalPaths}`);

    expect(ir.baseUrl).toBe('https://eu.api.example.com/v1');
    expect(ir.servers).toEqual([
      {
        url: 'https://{region}.api.example.com/v1',
        description: 'Regional API',
        variables: {
          region: { default: 'eu', enum: ['eu', 'us'], description: 'The region the account lives in.' },
        },
      },
    ]);
    expect(warnings()).toEqual([]);
  });

  it('leaves servers without variables as before, with no variables key', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
    description: Production
  - url: https://api.example.test
${minimalPaths}`);

    expect(ir.baseUrl).toBe('https://api.example.com');
    expect(ir.servers).toEqual([
      { url: 'https://api.example.com', description: 'Production' },
      { url: 'https://api.example.test' },
    ]);
    for (const server of ir.servers!) expect('variables' in server).toBe(false);
    expect(warnings()).toEqual([]);
  });

  it('carries enum and description only when the document declares them', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://{region}.api.example.com
    variables:
      region:
        default: eu
${minimalPaths}`);

    expect(ir.servers![0].variables).toStrictEqual({ region: { default: 'eu' } });
    expect(ir.baseUrl).toBe('https://eu.api.example.com');
  });

  it('substitutes a variable used more than once in the URL', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://{env}.example.com/{env}/v1
    variables:
      env: { default: staging }
${minimalPaths}`);

    expect(ir.baseUrl).toBe('https://staging.example.com/staging/v1');
    expect(ir.servers![0].url).toBe('https://{env}.example.com/{env}/v1');
    expect(warnings()).toEqual([]);
  });

  it('warns once about a placeholder with no declared variable and keeps it', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://{region}.example.com/{region}/{tenant}
    variables:
      tenant: { default: acme }
${minimalPaths}`);

    expect(ir.baseUrl).toBe('https://{region}.example.com/{region}/acme');
    expect(ir.servers![0].variables).toStrictEqual({ tenant: { default: 'acme' } });

    const messages = warnings();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('{region}');
    expect(messages[0]).toContain('declares no such variable');
    expect(messages[0]).toContain('https://{region}.example.com/{region}/{tenant}');
  });

  it('warns once about a variable without a default, omits it and keeps its placeholder', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://{region}.example.com/{tenant}
    variables:
      region:
        enum: [eu, us]
        description: No default here.
      tenant: { default: acme }
${minimalPaths}`);

    expect(ir.baseUrl).toBe('https://{region}.example.com/acme');
    expect(ir.servers![0].variables).toStrictEqual({ tenant: { default: 'acme' } });

    const messages = warnings();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('"region"');
    expect(messages[0]).toContain('has no default');
  });

  it('drops the variables key when no declared variable is usable', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://{region}.example.com
    variables:
      region: { enum: [eu, us] }
${minimalPaths}`);

    expect(ir.baseUrl).toBe('https://{region}.example.com');
    expect('variables' in ir.servers![0]).toBe(false);
    expect(warnings()).toHaveLength(1);
  });

  it('treats an empty variables map as none', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
    variables: {}
${minimalPaths}`);

    expect('variables' in ir.servers![0]).toBe(false);
    expect(warnings()).toEqual([]);
  });

  it('keeps a declared variable the URL never uses, without a warning', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
    variables:
      region: { default: eu, enum: [eu, us] }
${minimalPaths}`);

    expect(ir.baseUrl).toBe('https://api.example.com');
    expect(ir.servers![0].variables).toStrictEqual({ region: { default: 'eu', enum: ['eu', 'us'] } });
    expect(warnings()).toEqual([]);
  });

  it('warns about a default outside the enum and keeps both as written', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://{region}.example.com
    variables:
      region: { default: ap, enum: [eu, us] }
${minimalPaths}`);

    expect(ir.baseUrl).toBe('https://ap.example.com');
    expect(ir.servers![0].variables).toStrictEqual({ region: { default: 'ap', enum: ['eu', 'us'] } });

    const messages = warnings();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('"region"');
    expect(messages[0]).toContain('"ap"');
    expect(messages[0]).toContain('eu, us');
  });

  it('ignores an empty enum', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://{region}.example.com
    variables:
      region: { default: eu, enum: [] }
${minimalPaths}`);

    expect(ir.servers![0].variables).toStrictEqual({ region: { default: 'eu' } });
    expect(warnings()).toEqual([]);
  });

  it('carries a numeric default and enum as text', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com:{port}
    variables:
      port: { default: 8443, enum: [8443, 443] }
${minimalPaths}`);

    expect(ir.baseUrl).toBe('https://api.example.com:8443');
    expect(ir.servers![0].variables).toStrictEqual({ port: { default: '8443', enum: ['8443', '443'] } });
    expect(warnings()).toEqual([]);
  });

  it('reads the same shape from an OpenAPI 3.0 document', async () => {
    const ir = await parseYaml(`
openapi: '3.0.3'
info: { title: repro, version: '1' }
servers:
  - url: https://{region}.api.example.com/v1
    variables:
      region: { default: us, enum: [eu, us] }
${minimalPaths}`);

    expect(ir.baseUrl).toBe('https://us.api.example.com/v1');
    expect(ir.servers![0].variables).toStrictEqual({ region: { default: 'us', enum: ['eu', 'us'] } });
    expect(warnings()).toEqual([]);
  });

  it('resolves only the first server into baseUrl but checks every server', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: https://api.example.com
    description: Production
  - url: https://{region}.sandbox.example.com/{tenant}
    description: Sandbox
    variables:
      region: { default: eu, enum: [eu, us] }
${minimalPaths}`);

    expect(ir.baseUrl).toBe('https://api.example.com');
    expect(ir.servers).toEqual([
      { url: 'https://api.example.com', description: 'Production' },
      {
        url: 'https://{region}.sandbox.example.com/{tenant}',
        description: 'Sandbox',
        variables: { region: { default: 'eu', enum: ['eu', 'us'] } },
      },
    ]);
    expect('variables' in ir.servers![0]).toBe(false);

    // An emitter resolves the other servers with the same helper the parser used.
    expect(resolveServerUrl(ir.servers![1])).toEqual({
      url: 'https://eu.sandbox.example.com/{tenant}',
      unresolved: ['tenant'],
    });

    // The undeclared placeholder on the second server is reported too.
    const messages = warnings();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('{tenant}');
    expect(messages[0]).toContain('https://{region}.sandbox.example.com/{tenant}');
  });

  it('keeps a relative server URL, with or without a variable', async () => {
    const plain = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: /v1
${minimalPaths}`);
    expect(plain.baseUrl).toBe('/v1');
    expect(plain.servers).toEqual([{ url: '/v1' }]);

    const templated = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - url: /{version}
    variables:
      version: { default: v2, enum: [v1, v2] }
${minimalPaths}`);
    expect(templated.baseUrl).toBe('/v2');
    expect(templated.servers![0].variables).toStrictEqual({ version: { default: 'v2', enum: ['v1', 'v2'] } });
    expect(warnings()).toEqual([]);
  });

  it('skips a server entry without a URL, as before', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
servers:
  - description: No URL here
    variables:
      region: { default: eu }
  - url: https://api.example.com
${minimalPaths}`);

    expect(ir.baseUrl).toBe('https://api.example.com');
    expect(ir.servers).toEqual([{ url: 'https://api.example.com' }]);
    expect(warnings()).toEqual([]);
  });

  it('yields an empty baseUrl and no servers when the document declares none', async () => {
    const ir = await parseYaml(`
openapi: '3.1.0'
info: { title: repro, version: '1' }
${minimalPaths}`);

    expect(ir.baseUrl).toBe('');
    expect(ir.servers).toBeUndefined();
    expect(warnings()).toEqual([]);
  });
});
