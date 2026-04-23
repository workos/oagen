import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { loadConfig } from '../../src/cli/config-loader.js';
import { applyConfig } from '../../src/cli/plugin-loader.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { OagenConfig } from '../../src/cli/config-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '../../src/cli/index.ts');
const FIXTURES = resolve(__dirname, '../fixtures');
const POLICY_CONFIG = resolve(FIXTURES, 'oagen.config.policy.mjs');
const MINIMAL_SPEC = resolve(FIXTURES, 'minimal.yml');
const DTO_SPEC = resolve(FIXTURES, 'dto-schemas.yml');

function run(args: string[], env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      ['--import', 'tsx', CLI, ...args],
      {
        env: { ...process.env, ...env, OPENAPI_SPEC_PATH: undefined, DOTENV_CONFIG_PATH: '/dev/null' },
      },
      (error, stdout, stderr) => {
        resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr });
      },
    );
  });
}

describe('config propagation via --config', () => {
  describe('operationHints affect resolved operations', () => {
    it('applies operation hint name override in resolve output', async () => {
      const result = await run(['--config', POLICY_CONFIG, 'resolve', '--spec', MINIMAL_SPEC, '--format', 'json']);

      expect(result.code).toBe(0);
      const resolved = JSON.parse(result.stdout);
      const usersOp = resolved.find(
        (op: { path: string; method: string }) => op.path === '/users' && op.method === 'GET',
      );
      expect(usersOp).toBeDefined();
      expect(usersOp.derivedName).toBe('fetch_all_users');
    });
  });

  describe('mountRules affect resolved operations', () => {
    it('applies mount rule remapping in resolve output', async () => {
      // Use comprehensive.yml which has /organizations endpoints that produce an Organizations service
      const result = await run([
        '--config',
        POLICY_CONFIG,
        'resolve',
        '--spec',
        resolve(FIXTURES, 'comprehensive.yml'),
        '--format',
        'json',
      ]);

      expect(result.code).toBe(0);
      const resolved = JSON.parse(result.stdout);
      // The mountRule maps Organizations -> Admin, so ops originally on Organizations
      // should have mountOn set to Admin
      const remounted = resolved.filter((op: { mountOn: string }) => op.mountOn === 'Admin');
      expect(remounted.length).toBeGreaterThan(0);
    });
  });

  describe('schemaNameTransform propagates through config loading', () => {
    it('loads schemaNameTransform from explicit config path', async () => {
      const config = await loadConfig(POLICY_CONFIG);
      expect(config).not.toBeNull();
      expect(config!.schemaNameTransform).toBeDefined();
      expect(config!.schemaNameTransform!('UserDto')).toBe('User');
      expect(config!.schemaNameTransform!('Profile')).toBe('Profile');
    });
  });

  describe('operationIdTransform propagates through config loading', () => {
    it('loads operationIdTransform from explicit config path', async () => {
      const config = await loadConfig(POLICY_CONFIG);
      expect(config).not.toBeNull();
      expect(config!.operationIdTransform).toBeDefined();
      expect(config!.operationIdTransform!('listUsers')).toBe('getAllUsers');
      expect(config!.operationIdTransform!('getUser')).toBe('getUser');
    });
  });

  describe('smokeRunners from config', () => {
    it('loads smoke runner map from explicit config path', async () => {
      const config = await loadConfig(POLICY_CONFIG);
      expect(config).not.toBeNull();
      expect(config!.smokeRunners).toEqual({
        node: './smoke/custom-node.ts',
        python: './smoke/custom-python.ts',
      });
    });
  });
});

describe('plugin bundle composition', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-compose-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('composes emitters from multiple plugin bundles', () => {
    const bundleA: OagenConfig = {
      emitters: [
        {
          language: 'lang-a',
          generateModels: () => [],
          generateEnums: () => [],
          generateResources: () => [],
          generateClient: () => [],
          generateErrors: () => [],
          generateTypeSignatures: () => [],
          generateTests: () => [],
          fileHeader: () => '',
        },
      ],
      smokeRunners: { 'lang-a': './smoke/a.ts' },
    };

    const bundleB: OagenConfig = {
      emitters: [
        {
          language: 'lang-b',
          generateModels: () => [],
          generateEnums: () => [],
          generateResources: () => [],
          generateClient: () => [],
          generateErrors: () => [],
          generateTypeSignatures: () => [],
          generateTests: () => [],
          fileHeader: () => '',
        },
      ],
      smokeRunners: { 'lang-b': './smoke/b.ts' },
    };

    const composed: OagenConfig = {
      emitters: [...(bundleA.emitters ?? []), ...(bundleB.emitters ?? [])],
      smokeRunners: {
        ...bundleA.smokeRunners,
        ...bundleB.smokeRunners,
      },
    };

    expect(composed.emitters).toHaveLength(2);
    expect(composed.emitters![0].language).toBe('lang-a');
    expect(composed.emitters![1].language).toBe('lang-b');
    expect(composed.smokeRunners).toEqual({
      'lang-a': './smoke/a.ts',
      'lang-b': './smoke/b.ts',
    });
  });

  it('composed config registers all emitters via applyConfig', async () => {
    const { getEmitter } = await import('../../src/engine/registry.js');

    const composed: OagenConfig = {
      emitters: [
        {
          language: 'compose-test-a',
          generateModels: () => [],
          generateEnums: () => [],
          generateResources: () => [],
          generateClient: () => [],
          generateErrors: () => [],
          generateTypeSignatures: () => [],
          generateTests: () => [],
          fileHeader: () => '',
        },
        {
          language: 'compose-test-b',
          generateModels: () => [],
          generateEnums: () => [],
          generateResources: () => [],
          generateClient: () => [],
          generateErrors: () => [],
          generateTypeSignatures: () => [],
          generateTests: () => [],
          fileHeader: () => '',
        },
      ],
    };

    applyConfig(composed);

    expect(getEmitter('compose-test-a').language).toBe('compose-test-a');
    expect(getEmitter('compose-test-b').language).toBe('compose-test-b');
  });

  it('composed config loads smokeRunners from file and registers via applyConfig', async () => {
    // Write a config that simulates plugin composition
    const configContent = `
      const bundleA = { smokeRunners: { 'test-lang-x': './smoke/x.ts' } };
      const bundleB = { smokeRunners: { 'test-lang-y': './smoke/y.ts' } };
      export default {
        smokeRunners: { ...bundleA.smokeRunners, ...bundleB.smokeRunners },
      };
    `;
    writeFileSync(resolve(tmpDir, 'composed.config.mjs'), configContent);

    const config = await loadConfig(resolve(tmpDir, 'composed.config.mjs'));
    expect(config).not.toBeNull();
    expect(config!.smokeRunners).toEqual({
      'test-lang-x': './smoke/x.ts',
      'test-lang-y': './smoke/y.ts',
    });
  });
});

describe('schemaNameTransform applied through parse', () => {
  it('transforms Dto-suffixed model names in parsed IR', async () => {
    const ir = await parseSpec(DTO_SPEC, {
      schemaNameTransform: (name: string) => name.replace(/Dto$/, ''),
    });

    const modelNames = ir.models.map((m) => m.name);
    expect(modelNames).toContain('User');
    expect(modelNames).toContain('CreateUser');
    expect(modelNames).not.toContain('UserDto');
    expect(modelNames).not.toContain('CreateUserDto');
  });

  it('transforms $ref response types in operations', async () => {
    const ir = await parseSpec(DTO_SPEC, {
      schemaNameTransform: (name: string) => name.replace(/Dto$/, ''),
    });

    const service = ir.services.find((s) => s.operations.length > 0);
    expect(service).toBeDefined();

    // POST /users response references UserDto which should resolve to User
    const createOp = service!.operations.find((o) => o.name === 'createUser');
    expect(createOp).toBeDefined();
    expect(createOp!.response).toEqual({ kind: 'model', name: 'User' });
  });

  it('leaves non-matching names unchanged', async () => {
    const ir = await parseSpec(MINIMAL_SPEC, {
      schemaNameTransform: (name: string) => name.replace(/Dto$/, ''),
    });

    // minimal.yml has User and CreateUser (no Dto suffix) -- names should be unchanged
    const modelNames = ir.models.map((m) => m.name);
    expect(modelNames).toContain('User');
    expect(modelNames).toContain('CreateUser');
  });
});

describe('consumer-project config pattern', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(os.tmpdir(), `oagen-consumer-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads config from a consumer project that spreads a plugin bundle', async () => {
    // Simulate a consumer config that imports and spreads a plugin bundle,
    // then layers spec-policy on top (the canonical pattern from the migration plan)
    const configContent = `
      const plugin = {
        smokeRunners: { node: './smoke/node.ts', python: './smoke/python.ts' },
      };
      export default {
        ...plugin,
        docUrl: 'https://example.com/docs',
        operationIdTransform: (id) => id.replace(/Controller_/, ''),
        schemaNameTransform: (name) => name.replace(/Dto$/, ''),
        operationHints: {
          'GET /users': { name: 'list_all_users' },
        },
        mountRules: {
          SubService: 'MainService',
        },
      };
    `;
    writeFileSync(resolve(tmpDir, 'oagen.config.mjs'), configContent);

    const config = await loadConfig(undefined, tmpDir);
    expect(config).not.toBeNull();

    // Plugin-provided registrations
    expect(config!.smokeRunners).toEqual({
      node: './smoke/node.ts',
      python: './smoke/python.ts',
    });

    // Consumer-owned spec policy
    expect(config!.docUrl).toBe('https://example.com/docs');
    expect(config!.operationIdTransform!('Controller_listUsers')).toBe('listUsers');
    expect(config!.schemaNameTransform!('OrganizationDto')).toBe('Organization');
    expect(config!.operationHints).toEqual({ 'GET /users': { name: 'list_all_users' } });
    expect(config!.mountRules).toEqual({ SubService: 'MainService' });
  });

  it('runs resolve CLI with consumer config from a different directory', async () => {
    const configContent = `
      export default {
        operationHints: {
          'GET /users': { name: 'fetch_users' },
        },
      };
    `;
    writeFileSync(resolve(tmpDir, 'consumer.config.mjs'), configContent);

    const result = await run([
      '--config',
      resolve(tmpDir, 'consumer.config.mjs'),
      'resolve',
      '--spec',
      MINIMAL_SPEC,
      '--format',
      'json',
    ]);

    expect(result.code).toBe(0);
    const resolved = JSON.parse(result.stdout);
    const usersOp = resolved.find(
      (op: { path: string; method: string }) => op.path === '/users' && op.method === 'GET',
    );
    expect(usersOp).toBeDefined();
    expect(usersOp.derivedName).toBe('fetch_users');
  });

  it('plugin bundle smokeRunners are accessible per-language after config load', async () => {
    const configContent = `
      const plugin = {
        smokeRunners: {
          node: '/abs/path/smoke/node.ts',
          go: '/abs/path/smoke/go.ts',
          python: '/abs/path/smoke/python.ts',
        },
      };
      export default { ...plugin };
    `;
    writeFileSync(resolve(tmpDir, 'plugin-smoke.config.mjs'), configContent);

    const config = await loadConfig(resolve(tmpDir, 'plugin-smoke.config.mjs'));
    expect(config).not.toBeNull();

    // Verify per-language lookup works (this is the path the CLI uses at
    // index.ts:189 — opts.smokeRunner ??= configSmokeRunners?.[opts.lang])
    const runners = config!.smokeRunners!;
    expect(runners['node']).toBe('/abs/path/smoke/node.ts');
    expect(runners['go']).toBe('/abs/path/smoke/go.ts');
    expect(runners['python']).toBe('/abs/path/smoke/python.ts');
    expect(runners['ruby']).toBeUndefined();
  });
});
