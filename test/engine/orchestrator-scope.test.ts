import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generate } from '../../src/engine/orchestrator.js';
import { readManifest } from '../../src/engine/manifest.js';
import type { Emitter } from '../../src/engine/types.js';
import type { ApiSpec, Operation, Service, HttpMethod } from '../../src/ir/types.js';
import { defaultSdkBehavior } from '../../src/ir/sdk-behavior.js';

const HEADER = '# Auto-generated';

function op(httpMethod: HttpMethod, p: string): Operation {
  return {
    name: '',
    httpMethod,
    path: p,
    pathParams: [],
    queryParams: [],
    headerParams: [],
    response: { kind: 'primitive', type: 'unknown' },
    errors: [],
    injectIdempotencyKey: false,
  };
}

function svc(name: string, ops: Operation[]): Service {
  return { name, operations: ops };
}

/** Two-service spec: Sso and Vault, each owning one operation; no mount rules. */
const twoServiceSpec: ApiSpec = {
  name: 'TestApi',
  version: '1.0.0',
  baseUrl: 'https://api.test.com',
  services: [svc('Sso', [op('get', '/sso')]), svc('Vault', [op('get', '/vault')])],
  models: [],
  enums: [],
  sdk: defaultSdkBehavior(),
};

/**
 * Mock emitter modeling the real emitters under the emitter-aware design:
 * - generateResources GATES per-service emission on ctx.scopedServices (the spec
 *   is passed in full; the emitter decides what to emit).
 * - generateClient always runs over the FULL spec (engine never skips it), so the
 *   client lists every service and is byte-identical across scoped/full runs.
 * A spy records client builds so tests can assert it is NOT skipped.
 */
function scopeEmitter(spy: { clientCalls: number }): Emitter {
  return {
    language: 'mock',
    generateModels: () => [],
    generateEnums: () => [],
    generateResources: (services, ctx) =>
      services
        .filter((s) => !ctx.scopedServices || ctx.scopedServices.has(s.name))
        .map((s) => ({ path: `services/${s.name.toLowerCase()}.rb`, content: `class ${s.name}; end` })),
    generateClient: (spec) => {
      spy.clientCalls++;
      return [{ path: 'client.rb', content: `# client: ${spec.services.map((s) => s.name).join(',')}` }];
    },
    generateErrors: () => [],
    generateTypeSignatures: () => [],
    generateTests: () => [],
    fileHeader: () => HEADER,
  };
}

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'oagen-scope-'));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('orchestrator — scoped (--services) generation', () => {
  it('emits only the selected service resource, while the client (from the full spec) stays byte-identical', async () => {
    const outputDir = await tmp();
    try {
      const spy = { clientCalls: 0 };

      // Run 1: full generation populates both services + the client.
      await generate(twoServiceSpec, scopeEmitter(spy), { namespace: 'test', outputDir });
      expect(spy.clientCalls).toBe(1);
      const clientAfterFull = await fs.readFile(path.join(outputDir, 'client.rb'), 'utf-8');

      // Run 2: scoped to Vault only.
      await generate(twoServiceSpec, scopeEmitter(spy), { namespace: 'test', outputDir, services: ['Vault'] });

      // Vault re-emitted, Sso's file survives (no prune).
      expect(await fileExists(path.join(outputDir, 'services/vault.rb'))).toBe(true);
      expect(await fileExists(path.join(outputDir, 'services/sso.rb'))).toBe(true);
      // The client IS regenerated (engine no longer skips it) — but from the FULL
      // spec, so it still lists every service and is byte-identical.
      expect(spy.clientCalls).toBe(2);
      const clientAfterScoped = await fs.readFile(path.join(outputDir, 'client.rb'), 'utf-8');
      expect(clientAfterScoped).toBe(clientAfterFull);
      expect(clientAfterScoped).toContain('Sso,Vault');
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });

  it('merges the manifest so unselected services records survive a scoped run', async () => {
    const outputDir = await tmp();
    try {
      await generate(twoServiceSpec, scopeEmitter({ clientCalls: 0 }), { namespace: 'test', outputDir });
      await generate(twoServiceSpec, scopeEmitter({ clientCalls: 0 }), {
        namespace: 'test',
        outputDir,
        services: ['Vault'],
      });

      const manifest = await readManifest(outputDir);
      // Both the regenerated Vault file AND the previously-recorded sso/client files.
      expect(manifest!.files).toEqual(['client.rb', 'services/sso.rb', 'services/vault.rb']);
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });

  it('does not delete unselected files even though pruning would otherwise remove them', async () => {
    const outputDir = await tmp();
    try {
      // Run 1 (full) records both services in the manifest.
      await generate(twoServiceSpec, scopeEmitter({ clientCalls: 0 }), { namespace: 'test', outputDir });

      // Run 2 scoped to Vault: Sso is absent from this emission. A normal run
      // would prune services/sso.rb; scoped mode must not.
      await generate(twoServiceSpec, scopeEmitter({ clientCalls: 0 }), {
        namespace: 'test',
        outputDir,
        services: ['Vault'],
      });

      expect(await fileExists(path.join(outputDir, 'services/sso.rb'))).toBe(true);
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });

  it('regenerates the client when no --services is given (full-run regression)', async () => {
    const outputDir = await tmp();
    try {
      const spy = { clientCalls: 0 };
      await generate(twoServiceSpec, scopeEmitter(spy), { namespace: 'test', outputDir });
      await generate(twoServiceSpec, scopeEmitter(spy), { namespace: 'test', outputDir });
      // Both full runs emit the client (no scoping → no skip).
      expect(spy.clientCalls).toBe(2);
      expect(await fileExists(path.join(outputDir, 'client.rb'))).toBe(true);
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });

  it('passes the resolved post-mount scopedServices set to the emitter context', async () => {
    const outputDir = await tmp();
    try {
      const captured: Array<Set<string> | undefined> = [];
      const capturingEmitter: Emitter = {
        ...scopeEmitter({ clientCalls: 0 }),
        generateResources: (services, ctx) => {
          captured.push(ctx.scopedServices);
          return services
            .filter((s) => !ctx.scopedServices || ctx.scopedServices.has(s.name))
            .map((s) => ({ path: `services/${s.name.toLowerCase()}.rb`, content: `class ${s.name}; end` }));
        },
      };

      // Scoped run → ctx.scopedServices is the resolved set.
      await generate(twoServiceSpec, capturingEmitter, { namespace: 'test', outputDir, services: ['Vault'] });
      expect(captured.at(-1)).toEqual(new Set(['Vault']));

      // Full run → ctx.scopedServices is undefined (signal inert).
      await generate(twoServiceSpec, capturingEmitter, { namespace: 'test', outputDir });
      expect(captured.at(-1)).toBeUndefined();
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });

  it('throws a ConfigError listing valid services for an unknown --services value', async () => {
    const outputDir = await tmp();
    try {
      let caught: Error | undefined;
      try {
        await generate(twoServiceSpec, scopeEmitter({ clientCalls: 0 }), {
          namespace: 'test',
          outputDir,
          services: ['Nope'],
        });
      } catch (e) {
        caught = e as Error;
      }
      expect(caught?.name).toBe('ConfigError');
      expect(caught?.message).toContain('Sso');
      expect(caught?.message).toContain('Vault');
    } finally {
      await fs.rm(outputDir, { recursive: true });
    }
  });
});
