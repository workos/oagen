import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { loadConfig } from '../../src/cli/config-loader.js';
import { applyConfig } from '../../src/cli/plugin-loader.js';
import { parseSpec } from '../../src/parser/parse.js';
import type { OagenConfig } from '../../src/cli/config-loader.js';
import type { ApiSurface } from '../../src/compat/types.js';

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

  describe('emitterOptions from config', () => {
    it('loads language-specific emitter options from explicit config path', async () => {
      const config = await loadConfig(POLICY_CONFIG);
      expect(config).not.toBeNull();
      expect(config!.emitterOptions).toEqual({
        node: { adoptMissingServices: true },
        ruby: { preserveKeywordDefaults: true },
      });
    });

    it('passes only the active language options to the emitter context', async () => {
      const tmpDir = resolve(os.tmpdir(), `oagen-emitter-options-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      try {
        const outputDir = resolve(tmpDir, 'out');
        const configPath = resolve(tmpDir, 'oagen.config.mjs');
        writeFileSync(
          configPath,
          `
            export default {
              emitters: [{
                language: 'ctx-check',
                generateModels: () => [],
                generateEnums: () => [],
                generateResources: () => [],
                generateClient: (_spec, ctx) => [{
                  path: 'ctx.json',
                  content: JSON.stringify(ctx.emitterOptions ?? null),
                  headerPlacement: 'skip',
                }],
                generateErrors: () => [],
                generateTypeSignatures: () => [],
                generateTests: () => [],
                fileHeader: () => '',
              }],
              emitterOptions: {
                'ctx-check': { adoptMissingServices: true },
                other: { leaked: true },
              },
            };
          `,
        );

        const result = await run([
          '--config',
          configPath,
          'generate',
          '--spec',
          MINIMAL_SPEC,
          '--lang',
          'ctx-check',
          '--output',
          outputDir,
        ]);

        expect(result.code).toBe(0);
        const generated = await import('node:fs/promises').then((fs) =>
          fs.readFile(resolve(outputDir, 'ctx.json'), 'utf8'),
        );
        expect(JSON.parse(generated)).toEqual({ adoptMissingServices: true });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
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

describe('collapseErrorBodies from config reaches every command that parses a spec', () => {
  // The pass folds inline error bodies by default (collapse-error-bodies.ts);
  // `collapseErrorBodies: false` in oagen.config must reach `parse` and `diff`
  // as it reaches `generate`, or a diff reads model names the generated SDK
  // does not have (workos/oagen#497 review).
  const dir = resolve(os.tmpdir(), `oagen-collapse-config-${process.pid}`);
  const config = resolve(dir, 'oagen.config.mjs');
  const oldSpec = resolve(dir, 'old.json');
  const newSpec = resolve(dir, 'new.json');
  const message = {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  };
  const op = (id: string, responses: Record<string, unknown>) => ({
    get: {
      operationId: id,
      responses: {
        '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } },
        ...responses,
      },
    },
  });
  const notFound = { description: 'nf', content: { 'application/json': { schema: message } } };
  const doc = (petsResponses: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'collapse', version: '1' },
    paths: {
      '/pets': op('getPets', petsResponses),
      '/notes': op('getNotes', { '404': notFound }),
    },
  });

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(config, 'export default { collapseErrorBodies: false };\n');
    writeFileSync(oldSpec, JSON.stringify(doc({ '404': notFound })));
    writeFileSync(newSpec, JSON.stringify(doc({ '404': notFound, '409': { ...notFound, description: 'dup' } })));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const modelNamesOf = (stdout: string): string[] =>
    (JSON.parse(stdout).models as Array<{ name: string }>).map((m) => m.name).sort();

  it('parse: folds by default and keeps per-operation models under the opt-out', async () => {
    const folded = await run(['parse', '--spec', oldSpec]);
    expect(folded.code).toBe(0);
    expect(modelNamesOf(folded.stdout)).toEqual(['ErrorBody']);

    const kept = await run(['--config', config, 'parse', '--spec', oldSpec]);
    expect(kept.code).toBe(0);
    expect(modelNamesOf(kept.stdout)).toEqual(['GetNotesError404', 'GetPetsError404']);
  });

  it('diff: reports the model a new error body adds only under the opt-out, as generation would', async () => {
    // `diff` exits 1 when it reports non-breaking changes (the new 409 entry itself).
    const folded = await run(['diff', '--old', oldSpec, '--new', newSpec]);
    expect(folded.code).toBe(1);
    const foldedKinds = (JSON.parse(folded.stdout).changes as Array<{ kind: string }>).map((c) => c.kind);
    expect(foldedKinds).not.toContain('model-added');

    const kept = await run(['--config', config, 'diff', '--old', oldSpec, '--new', newSpec]);
    expect(kept.code).toBe(1);
    const added = (JSON.parse(kept.stdout).changes as Array<{ kind: string; name?: string }>)
      .filter((c) => c.kind === 'model-added')
      .map((c) => c.name);
    expect(added).toEqual(['GetPetsError409']);
  });
});

describe('fieldHints from config reach every command that parses a spec (#507)', () => {
  // A hinted field's `domainName` is part of an error body's shape (#497),
  // which its shared name reads (#515), so hinting getPet's 404 keeps it
  // apart from getNote's identical one: generation reads
  // `ErrorBodyWithMessageAsDetail` (`message` → `detail`) beside getNote's
  // `ErrorBody`, where a parse without the hint folds both onto one
  // `ErrorBody`; getToy's 404, hinted to `reason`, is a third model. Every
  // other command has to read the models generation writes.
  const dir = resolve(os.tmpdir(), `oagen-field-hints-config-${process.pid}`);
  const config = resolve(dir, 'oagen.config.mjs');
  const spec = resolve(dir, 'spec.json');
  const withToys = resolve(dir, 'with-toys.json');
  const withClash = resolve(dir, 'with-clash.json');
  const surface = resolve(dir, 'surface.json');
  const runner = resolve(dir, 'smoke-runner.mjs');
  const get = (operationId: string) => ({
    get: {
      operationId,
      responses: {
        '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } },
        '404': {
          description: 'nf',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
            },
          },
        },
      },
    },
  });
  const doc = (paths: Record<string, unknown>) => ({ openapi: '3.1.0', info: { title: 'hints', version: '1' }, paths });
  // The SDK generated from with-toys.json under the hint, as an extractor reads it.
  const iface = (name: string) => ({
    name,
    fields: { message: { name: 'message', type: 'string', optional: false } },
    extends: [],
  });
  const sdkSurface = {
    language: 'field-hints',
    extractedFrom: dir,
    extractedAt: '2026-01-01T00:00:00.000Z',
    classes: {},
    interfaces: Object.fromEntries(
      ['ErrorBody', 'ErrorBodyWithMessageAsDetail', 'ErrorBodyWithMessageAsReason'].map((n) => [n, iface(n)]),
    ),
    typeAliases: {},
    enums: {},
    exports: {},
  };

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      config,
      `export default {
        fieldHints: { GetPetError404: { message: 'detail' }, GetToyError404: { message: 'reason' } },
        extractors: [{
          language: 'field-hints',
          hints: { derivedModelNames: () => [] },
          extract: async () => (${JSON.stringify(sdkSurface)}),
        }],
      };\n`,
    );
    writeFileSync(spec, JSON.stringify(doc({ '/pets': get('getPet'), '/notes': get('getNote') })));
    writeFileSync(
      withToys,
      JSON.stringify(doc({ '/pets': get('getPet'), '/notes': get('getNote'), '/toys': get('getToy') })),
    );
    // A component of another shape holding the hinted body's name: the fold
    // leaves that body as it is, with a warning, only when it reads the hint.
    writeFileSync(
      withClash,
      JSON.stringify({
        ...doc({ '/pets': get('getPet'), '/notes': get('getNote') }),
        components: {
          schemas: { ErrorBodyWithMessageAsDetail: { type: 'object', properties: { unrelated: { type: 'string' } } } },
        },
      }),
    );
    writeFileSync(surface, JSON.stringify(sdkSurface));
    writeFileSync(runner, '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const modelsOf = (stdout: string): string[] =>
    (JSON.parse(stdout).models as Array<{ name: string; fields: Array<{ name: string; domainName?: string }> }>)
      .map(
        ({ name, fields }) =>
          `${name} { ${fields.map((f) => (f.domainName ? `${f.name} → ${f.domainName}` : f.name)).join(', ')} }`,
      )
      .sort();

  it('parse: keeps the hinted body apart from its unhinted twin, as generation does', async () => {
    const unhinted = await run(['parse', '--spec', spec]);
    expect(unhinted.code).toBe(0);
    expect(modelsOf(unhinted.stdout)).toEqual(['ErrorBody { message }']);

    const hinted = await run(['--config', config, 'parse', '--spec', spec]);
    expect(hinted.code).toBe(0);
    expect(modelsOf(hinted.stdout)).toEqual([
      'ErrorBody { message }',
      'ErrorBodyWithMessageAsDetail { message → detail }',
    ]);
  });

  it('diff: reports the model a new unhinted body adds beside the hinted one, as generation would', async () => {
    // `diff` exits 1 when it reports non-breaking changes (the new Toys service itself).
    const addedModels = (stdout: string) =>
      (JSON.parse(stdout).changes as Array<{ kind: string; name?: string }>)
        .filter((c) => c.kind === 'model-added')
        .map((c) => c.name);
    const unhinted = await run(['diff', '--old', spec, '--new', withToys]);
    expect(unhinted.code).toBe(1);
    expect(addedModels(unhinted.stdout)).toEqual([]);

    const hinted = await run(['--config', config, 'diff', '--old', spec, '--new', withToys]);
    expect(hinted.code).toBe(1);
    expect(addedModels(hinted.stdout)).toEqual(['ErrorBodyWithMessageAsReason']);
  });

  it('resolve: warns about the body the hint keeps apart, as generation does', async () => {
    // `resolve` prints no model; the fold's warning naming the kept one tells.
    const unhinted = await run(['resolve', '--spec', withClash, '--format', 'json']);
    expect(unhinted.code).toBe(0);
    expect(unhinted.stderr).not.toContain('GetPetError404');

    const result = await run(['--config', config, 'resolve', '--spec', withClash, '--format', 'json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      'would be named "ErrorBodyWithMessageAsDetail", which component schema "ErrorBodyWithMessageAsDetail" already holds — keeping model "GetPetError404" as it is',
    );
  });

  it('compat-extract: gives the kept model’s SDK symbols their schema name', async () => {
    const result = await run([
      '--config',
      config,
      'compat-extract',
      '--sdk-path',
      dir,
      '--lang',
      'field-hints',
      '--output',
      dir,
      '--spec',
      spec,
    ]);
    expect(result.code).toBe(0);
    const snapshot = JSON.parse(readFileSync(resolve(dir, '.oagen-compat-snapshot.json'), 'utf8'));
    expect((snapshot.symbols as Array<{ schemaName?: string }>).map((s) => s.schemaName).filter(Boolean)).toEqual([
      'ErrorBody',
      'ErrorBody.message',
      'ErrorBodyWithMessageAsDetail',
      'ErrorBodyWithMessageAsDetail.message',
    ]);
  });

  it('verify: scopes compat and detects staleness on the models generation writes', async () => {
    const result = await run([
      '--config',
      config,
      'verify',
      '--spec',
      spec,
      '--old-spec',
      withToys,
      '--lang',
      'field-hints',
      '--output',
      dir,
      '--api-surface',
      surface,
      '--max-retries',
      '0',
      '--raw-results',
      resolve(dir, 'smoke-results-raw.json'),
      '--smoke-runner',
      runner,
    ]);
    expect(result.code).toBe(0);
    // Each of the three parses needs the hint: without it, the compat parse of
    // the new spec keeps only `ErrorBody` in scope (1/3), the staleness parse
    // of the old spec finds nothing removed, and that of the new spec reports
    // `ErrorBodyWithMessageAsDetail` stale as well.
    expect(result.stdout).toContain('(scoped to spec: 2/3 baseline symbols in scope)');
    expect(result.stdout).toContain('Found 1 stale symbol(s):');
    expect(result.stdout).toContain(
      'ErrorBodyWithMessageAsReason — Interface "ErrorBodyWithMessageAsReason" is no longer defined in the OpenAPI spec',
    );
  });
});

describe('the settings generate reads from config reach compat-extract and verify (#567)', () => {
  // `generate` parses with the config's `operationHints` and
  // `operationIdTransform`, and hands the engine its `mountRules`,
  // `operationHints` and the language's `emitterOptions`. `compat-extract`
  // and `verify` have to parse the same way, and `verify`'s overlay retry
  // has to regenerate the same way, or they read models and operation names
  // the generated SDK does not have and the retry writes services and
  // methods `generate` does not.
  const dir = resolve(os.tmpdir(), `oagen-generate-settings-config-${process.pid}`);
  const config = resolve(dir, 'oagen.config.mjs');
  const retryConfig = resolve(dir, 'retry.config.mjs');
  const listSpec = resolve(dir, 'list.json');
  const petsSpec = resolve(dir, 'pets.json');
  const petsControllerSpec = resolve(dir, 'pets-controller.json');
  const sdk = resolve(dir, 'sdk');
  const sdkSurface = resolve(sdk, 'surface.json');
  const baseline = resolve(dir, 'baseline.json');
  const runner = resolve(dir, 'smoke-runner.mjs');
  const snapshot = resolve(dir, '.oagen-compat-snapshot.json');

  const pet = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
  const ok = (schema: unknown) => ({ '200': { description: 'ok', content: { 'application/json': { schema } } } });
  const doc = (paths: Record<string, unknown>, tags?: string[]) => ({
    openapi: '3.1.0',
    info: { title: 'pets', version: '1' },
    ...(tags && { tags: tags.map((name) => ({ name })) }),
    paths,
    components: { schemas: { Pet: pet } },
  });
  // GET /pets with an `after` query parameter and a list envelope is detected
  // as cursor pagination, so the envelope is the iterator's and `Pet` the only
  // model. Under the hint it is a plain operation, and generation writes
  // `ListPetsResponse` and `ListPetsResponseListMetadata` beside `Pet`.
  const listDoc = doc({
    '/pets': {
      get: {
        operationId: 'listPets',
        parameters: [{ name: 'after', in: 'query', schema: { type: 'string' } }],
        responses: ok({
          type: 'object',
          required: ['data', 'list_metadata'],
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
            list_metadata: { type: 'object', properties: { after: { type: 'string' } } },
          },
        }),
      },
    },
  });
  // GET /pets and GET /pets/{id} tagged Pets, with ids the config's transform
  // strips to `list` and `get` (`prefix` empty: written so in the document).
  const petsDoc = (prefix: string) =>
    doc(
      {
        '/pets': {
          get: {
            operationId: `${prefix}list`,
            tags: ['Pets'],
            responses: ok({ type: 'array', items: { $ref: '#/components/schemas/Pet' } }),
          },
        },
        '/pets/{id}': {
          get: {
            operationId: `${prefix}get`,
            tags: ['Pets'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: ok({ $ref: '#/components/schemas/Pet' }),
          },
        },
      },
      ['Pets'],
    );

  // The SDK surfaces as an extractor reads them.
  const iface = (name: string, fields: Record<string, string>) => ({
    name,
    fields: Object.fromEntries(Object.entries(fields).map(([n, type]) => [n, { name: n, type, optional: false }])),
    extends: [],
  });
  const surface = (parts: Partial<ApiSurface>): ApiSurface => ({
    language: 'pets',
    extractedFrom: sdk,
    extractedAt: '2026-01-01T00:00:00.000Z',
    classes: {},
    interfaces: {},
    typeAliases: {},
    enums: {},
    exports: {},
    ...parts,
  });
  const listSurface = surface({
    interfaces: {
      ListPetsResponse: iface('ListPetsResponse', { data: 'Pet[]', list_metadata: 'ListPetsResponseListMetadata' }),
      ListPetsResponseListMetadata: iface('ListPetsResponseListMetadata', { after: 'string' }),
      Pet: iface('Pet', { name: 'string' }),
    },
  });
  const petsSurface = surface({
    classes: {
      Pets: {
        name: 'Pets',
        methods: {
          get: [{ name: 'get', params: [], returnType: 'Pet', async: true }],
          list: [{ name: 'list', params: [], returnType: 'Pet[]', async: true }],
        },
        properties: {},
        constructorParams: [],
      },
    },
    interfaces: { Pet: iface('Pet', { name: 'string' }) },
  });

  // Every config registers this extractor, which reads an SDK's surface from
  // its surface.json.
  const extractors = `extractors: [{
    language: 'pets',
    hints: { derivedModelNames: () => [] },
    extract: async (sdkPath) => JSON.parse(readFileSync(join(sdkPath, 'surface.json'), 'utf8')),
  }]`;
  const prelude = `import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\n`;

  beforeEach(() => {
    mkdirSync(sdk, { recursive: true });
    writeFileSync(
      config,
      `${prelude}export default {
        ${extractors},
        operationHints: { 'GET /pets': { pagination: { strategy: 'none' } } },
        operationIdTransform: (id) => (id.startsWith('PetsController_') ? id.slice('PetsController_'.length) : id),
      };\n`,
    );
    // The retry config also registers an emitter whose one file is the SDK's
    // surface as the engine resolved it: one class per mount target holding
    // its method names, one interface per model, and the options it was
    // handed.
    writeFileSync(
      retryConfig,
      `${prelude}const surfaceOf = (spec, ctx) => {
        const classes = {};
        for (const r of ctx.resolvedOperations) {
          classes[r.mountOn] ??= { name: r.mountOn, methods: {}, properties: {}, constructorParams: [] };
          classes[r.mountOn].methods[r.methodName] = [{ name: r.methodName, params: [], returnType: 'unknown', async: true }];
        }
        const interfaces = Object.fromEntries(
          spec.models.map((m) => [
            m.name,
            {
              name: m.name,
              fields: Object.fromEntries(m.fields.map((f) => [f.name, { name: f.name, type: 'string', optional: !f.required }])),
              extends: [],
            },
          ]),
        );
        return {
          language: 'pets',
          extractedFrom: 'sdk',
          extractedAt: '2026-01-01T00:00:00.000Z',
          classes,
          interfaces,
          typeAliases: {},
          enums: {},
          exports: {},
          emitterOptions: ctx.emitterOptions ?? null,
        };
      };
      export default {
        ${extractors},
        emitters: [{
          language: 'pets',
          generateModels: () => [],
          generateEnums: () => [],
          generateResources: () => [],
          generateClient: (spec, ctx) => [
            { path: 'surface.json', content: JSON.stringify(surfaceOf(spec, ctx), null, 2) + '\\n', headerPlacement: 'skip' },
          ],
          generateErrors: () => [],
          generateTypeSignatures: () => [],
          generateTests: () => [],
          fileHeader: () => '',
        }],
        mountRules: { Pets: 'Animals' },
        operationHints: { 'GET /pets': { name: 'list_all' } },
        emitterOptions: { pets: { flavor: 'retry' } },
      };\n`,
    );
    writeFileSync(listSpec, JSON.stringify(listDoc));
    writeFileSync(petsSpec, JSON.stringify(petsDoc('')));
    writeFileSync(petsControllerSpec, JSON.stringify(petsDoc('PetsController_')));
    writeFileSync(runner, '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const verifyArgs = (spec: string) => [
    'verify',
    '--spec',
    spec,
    '--lang',
    'pets',
    '--output',
    sdk,
    '--api-surface',
    baseline,
    '--raw-results',
    resolve(dir, 'smoke-results-raw.json'),
    '--smoke-runner',
    runner,
  ];
  const readSurface = () => JSON.parse(readFileSync(sdkSurface, 'utf8')) as ApiSurface & { emitterOptions: unknown };
  const shapeOf = (s: ReturnType<typeof readSurface>) => ({
    classes: Object.fromEntries(
      Object.entries(s.classes).map(([name, cls]) => [name, Object.keys(cls.methods).sort()]),
    ),
    interfaces: Object.keys(s.interfaces).sort(),
    emitterOptions: s.emitterOptions,
  });

  it('compat-extract: names the models the pagination hint makes generation write', async () => {
    writeFileSync(sdkSurface, JSON.stringify(listSurface));
    const result = await run([
      '--config',
      config,
      'compat-extract',
      '--sdk-path',
      sdk,
      '--lang',
      'pets',
      '--output',
      dir,
      '--spec',
      listSpec,
    ]);
    expect(result.code).toBe(0);
    // Parsed without the hint, only `Pet` and `Pet.name` were named.
    const symbols = JSON.parse(readFileSync(snapshot, 'utf8')).symbols as Array<{ schemaName?: string }>;
    expect(symbols.map((s) => s.schemaName).sort()).toEqual([
      'ListPetsResponse',
      'ListPetsResponse.data',
      'ListPetsResponse.list_metadata',
      'ListPetsResponseListMetadata',
      'ListPetsResponseListMetadata.after',
      'Pet',
      'Pet.name',
    ]);
  });

  it('verify: scopes compat to the models the pagination hint makes generation write', async () => {
    // The SDK lost the two envelope models. Parsed without the hint, verify
    // scoped them out (1/3 in scope) and passed.
    writeFileSync(baseline, JSON.stringify(listSurface));
    writeFileSync(sdkSurface, JSON.stringify(surface({ interfaces: { Pet: listSurface.interfaces.Pet } })));
    const result = await run(['--config', config, ...verifyArgs(listSpec), '--max-retries', '0']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('(scoped to spec: 3/3 baseline symbols in scope)');
    expect(result.stdout).toContain(
      '[symbol_removed] breaking: ListPetsResponse — Symbol "ListPetsResponse" was removed',
    );
    expect(result.stdout).toContain('[symbol_removed] breaking: ListPetsResponseListMetadata.after — ');
    expect(result.stderr).toContain('Compat violations found');
  });

  it('compat-extract: matches the methods operationIdTransform names', async () => {
    // Parsed without the transform, `Pets.get` and `Pets.list` matched no
    // operation and got neither `operationId` nor `route`.
    writeFileSync(sdkSurface, JSON.stringify(petsSurface));
    const result = await run([
      '--config',
      config,
      'compat-extract',
      '--sdk-path',
      sdk,
      '--lang',
      'pets',
      '--output',
      dir,
      '--spec',
      petsControllerSpec,
    ]);
    expect(result.code).toBe(0);
    const symbols = JSON.parse(readFileSync(snapshot, 'utf8')).symbols as Array<{
      kind: string;
      fqName: string;
      operationId?: string;
      route?: unknown;
    }>;
    expect(
      symbols
        .filter((s) => s.kind === 'callable')
        .map(({ fqName, operationId, route }) => ({ fqName, operationId, route })),
    ).toEqual([
      { fqName: 'Pets.get', operationId: 'get', route: { method: 'get', path: '/pets/{id}' } },
      { fqName: 'Pets.list', operationId: 'list', route: { method: 'get', path: '/pets' } },
    ]);
  });

  it('compat-extract: matches the methods mountRules and a name hint give the SDK', async () => {
    // `generate` under the retry config writes `Animals: get_pet, list_all`;
    // an SDK whose `Animals` carries `get` (named after its operationId) and
    // `list_all` is that SDK. Matched by the IR's `Pets.get` and `Pets.list`
    // alone, both got `operationId: null, route: null`.
    const method = (name: string) => [{ name, params: [], returnType: 'Pet', async: true }];
    writeFileSync(
      sdkSurface,
      JSON.stringify(
        surface({
          classes: {
            Animals: {
              name: 'Animals',
              methods: { get: method('get'), list_all: method('list_all') },
              properties: {},
              constructorParams: [],
            },
          },
          interfaces: { Pet: iface('Pet', { name: 'string' }) },
        }),
      ),
    );
    const result = await run([
      '--config',
      retryConfig,
      'compat-extract',
      '--sdk-path',
      sdk,
      '--lang',
      'pets',
      '--output',
      dir,
      '--spec',
      petsSpec,
    ]);
    expect(result.code).toBe(0);
    const symbols = JSON.parse(readFileSync(snapshot, 'utf8')).symbols as Array<{
      kind: string;
      fqName: string;
      operationId?: string;
      route?: unknown;
    }>;
    expect(
      symbols
        .filter((s) => s.kind === 'callable')
        .map(({ fqName, operationId, route }) => ({ fqName, operationId, route })),
    ).toEqual([
      { fqName: 'Animals.get', operationId: 'get', route: { method: 'get', path: '/pets/{id}' } },
      { fqName: 'Animals.list_all', operationId: 'list', route: { method: 'get', path: '/pets' } },
    ]);
  });

  it('verify: the overlay retry regenerates with the mount rules, hints and emitter options generate used', async () => {
    const generated = await run([
      '--config',
      retryConfig,
      'generate',
      '--spec',
      petsSpec,
      '--lang',
      'pets',
      '--output',
      sdk,
    ]);
    expect(generated.code).toBe(0);
    const written = readSurface();
    const expected = {
      classes: { Animals: ['get_pet', 'list_all'] },
      interfaces: ['Pet'],
      emitterOptions: { flavor: 'retry' },
    };
    expect(shapeOf(written)).toEqual(expected);

    // The SDK lost `Pet`; the retry patches the overlay and regenerates into
    // it. Regenerated without the settings, it wrote a `Pets` class with
    // `get_pet` and `list_pets` beside `Animals` and dropped the options.
    writeFileSync(baseline, JSON.stringify(written));
    writeFileSync(sdkSurface, JSON.stringify({ ...written, interfaces: {} }));
    const result = await run(['--config', retryConfig, ...verifyArgs(petsSpec)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Retry 1/3: patching 2 violation(s)...');
    expect(result.stdout).toContain('Compat: converged after 1 retry iteration(s)');
    expect(shapeOf(readSurface())).toEqual(expected);
  });
});
