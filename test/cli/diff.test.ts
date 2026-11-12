import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');
const V1 = resolve(FIXTURES, 'v1.yml');
const V2_ADDITIVE = resolve(FIXTURES, 'v2-additive.yml');

import { diffCommand } from '../../src/cli/diff.js';

describe('diffCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('outputs JSON diff report', async () => {
    await expect(
      diffCommand({
        old: V1,
        new: V2_ADDITIVE,
      }),
    ).rejects.toThrow();

    // Find the call that contains valid JSON (the diff report)
    const jsonCall = consoleSpy.mock.calls.find((call: unknown[]) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const diff = JSON.parse(jsonCall![0] as string);
    expect(diff).toHaveProperty('changes');
    expect(diff).toHaveProperty('summary');
  });

  it('exits 2 for breaking changes', async () => {
    const V2_BREAKING = resolve(FIXTURES, 'v2-breaking.yml');
    await expect(
      diffCommand({
        old: V1,
        new: V2_BREAKING,
      }),
    ).rejects.toThrow();

    const jsonCall = consoleSpy.mock.calls.find((call: unknown[]) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    const diff = JSON.parse(jsonCall![0] as string);
    expect(diff.summary.breaking).toBeGreaterThan(0);
  });

  it('exits 0 for no changes', async () => {
    const err: any = await diffCommand({
      old: V1,
      new: V1,
    }).catch((e) => e);

    expect(err).toBeDefined();
    expect(err.exitCode).toBe(0);
  });

  it('exits 1 for additive-only changes', async () => {
    const err: any = await diffCommand({
      old: V1,
      new: V2_ADDITIVE,
    }).catch((e) => e);

    expect(err).toBeDefined();
    expect(err.exitCode).toBe(1);
  });
});

describe('diffCommand — a validation keyword tightened or loosened (#599)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oagen-599-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The issue's document: `getPet` with `petId` (`pattern`) and `limit`
   * (`minimum`) returning `Pet`, and `createPet` taking `Pet`, whose `name`
   * carries `maxLength` and `id` the same `pattern`.
   */
  function write(
    name: string,
    openapi: string,
    limits: { pattern: string; maxLength: number; minimum: number },
  ): string {
    const path = join(dir, name);
    const pet = { $ref: '#/components/schemas/Pet' };
    writeFileSync(
      path,
      JSON.stringify({
        openapi,
        info: { title: 'Pets', version: '1' },
        paths: {
          '/pets/{petId}': {
            get: {
              operationId: 'getPet',
              parameters: [
                { name: 'petId', in: 'path', required: true, schema: { type: 'string', pattern: limits.pattern } },
                { name: 'limit', in: 'query', schema: { type: 'integer', minimum: limits.minimum } },
              ],
              responses: { '200': { description: 'ok', content: { 'application/json': { schema: pet } } } },
            },
          },
          '/pets': {
            post: {
              operationId: 'createPet',
              requestBody: { content: { 'application/json': { schema: pet } } },
              responses: { '201': { description: 'ok', content: { 'application/json': { schema: pet } } } },
            },
          },
        },
        components: {
          schemas: {
            Pet: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string', maxLength: limits.maxLength },
                id: { type: 'string', pattern: limits.pattern },
              },
            },
          },
        },
      }),
    );
    return path;
  }

  async function exitCodeOf(oldPath: string, newPath: string): Promise<number> {
    const err: any = await diffCommand({ old: oldPath, new: newPath }).catch((e) => e);
    return err.exitCode;
  }

  for (const openapi of ['3.0.3', '3.1.0']) {
    it(`exits 2 for a limit tightened or a pattern rewritten, 1 for a bound loosened alone, 0 for no change (OpenAPI ${openapi})`, async () => {
      const pattern = '^pet_[0-9A-Z]{26}$';
      const before = write('before.json', openapi, { pattern, maxLength: 100, minimum: 1 });
      // The issue's `new.json`: both patterns rewritten, `maxLength` lowered, `minimum` raised.
      const issue = write('issue.json', openapi, { pattern: '^pet_[0-9A-Z]{12}$', maxLength: 10, minimum: 5 });
      const loosened = write('loosened.json', openapi, { pattern, maxLength: 200, minimum: 0 });
      const tightened = write('tightened.json', openapi, { pattern, maxLength: 10, minimum: 5 });
      expect(await exitCodeOf(before, issue), 'issue old → new').toBe(2);
      // A rewritten pattern is tightened either way.
      expect(await exitCodeOf(issue, before), 'issue new → old').toBe(2);
      expect(await exitCodeOf(before, tightened), 'bounds tightened').toBe(2);
      expect(await exitCodeOf(tightened, before), 'bounds loosened').toBe(1);
      expect(await exitCodeOf(before, loosened), 'bounds loosened').toBe(1);
      expect(await exitCodeOf(loosened, before), 'bounds tightened').toBe(2);
      expect(await exitCodeOf(before, before), 'unchanged').toBe(0);
    });
  }
});

describe('diffCommand — a required flag on a body carried in requestBodyContents alone (#528)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oagen-528-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The parser warns that it reads no media type of the xml and range bodies.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The issue's `createPet`: a `{ name }` body under one media type, `required` as given, responding `204`. */
  function write(name: string, openapi: string, mediaType: string, required: boolean): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify({
        openapi,
        info: { title: 'Pets', version: '1' },
        paths: {
          '/pets': {
            post: {
              operationId: 'createPet',
              requestBody: {
                required,
                content: { [mediaType]: { schema: { type: 'object', properties: { name: { type: 'string' } } } } },
              },
              responses: { '204': { description: 'no content' } },
            },
          },
        },
      }),
    );
    return path;
  }

  async function exitCodeOf(oldPath: string, newPath: string): Promise<number> {
    const err: any = await diffCommand({ old: oldPath, new: newPath }).catch((e) => e);
    return err.exitCode;
  }

  for (const openapi of ['3.0.3', '3.1.0']) {
    it(`exits 2 for optional → required and 1 for required → optional, as for application/json (OpenAPI ${openapi})`, async () => {
      for (const [name, mediaType] of [
        ['json', 'application/json'],
        ['xml', 'application/xml'],
        ['range', 'application/*+json'],
      ]) {
        const optional = write(`${name}-optional.json`, openapi, mediaType, false);
        const required = write(`${name}-required.json`, openapi, mediaType, true);
        expect(await exitCodeOf(optional, required), `${name} optional → required`).toBe(2);
        expect(await exitCodeOf(required, optional), `${name} required → optional`).toBe(1);
        expect(await exitCodeOf(required, required), `${name} unchanged`).toBe(0);
      }
    });
  }
});

describe('diffCommand — a moved success status code (#407)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oagen-407-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The issue's `createPet` declaring `responses`: each 2xx an inline `{ id }` body, each 3xx a `Location` header. */
  const body = { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } };
  const location = { Location: { schema: { type: 'string' } } };
  function write(name: string, openapi: string, responses: Record<string, unknown>): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify({
        openapi,
        info: { title: 'Pets', version: '1' },
        paths: { '/pets': { post: { operationId: 'createPet', responses } } },
      }),
    );
    return path;
  }

  async function exitCodeOf(oldPath: string, newPath: string): Promise<number> {
    const err: any = await diffCommand({ old: oldPath, new: newPath }).catch((e) => e);
    return err.exitCode;
  }

  for (const openapi of ['3.0.3', '3.1.0']) {
    it(`exits 2 for a lone code that moved and 1 for a 200 added beside a kept 201 (OpenAPI ${openapi})`, async () => {
      const lone200 = write('lone200.json', openapi, { '200': { description: 'OK', content: body } });
      const lone201 = write('lone201.json', openapi, { '201': { description: 'Created', content: body } });
      const lone302 = write('lone302.json', openapi, { '302': { description: 'Found', headers: location } });
      const lone301 = write('lone301.json', openapi, { '301': { description: 'Moved', headers: location } });
      const both = write('both.json', openapi, {
        '200': { description: 'OK', content: body },
        '201': { description: 'Created', content: body },
      });
      // The issue's three diffs: the first two used to exit 1.
      expect(await exitCodeOf(lone200, lone201), 'lone200 → lone201').toBe(2);
      expect(await exitCodeOf(lone302, lone301), 'lone302 → lone301').toBe(2);
      expect(await exitCodeOf(both, lone201), 'both → lone201').toBe(2);
      // The other way round, and the one move that keeps the old code declared.
      expect(await exitCodeOf(lone201, lone200), 'lone201 → lone200').toBe(2);
      expect(await exitCodeOf(lone301, lone302), 'lone301 → lone302').toBe(2);
      expect(await exitCodeOf(lone201, both), 'lone201 → both').toBe(1);
      expect(await exitCodeOf(lone200, lone200), 'unchanged').toBe(0);
    });
  }
});
