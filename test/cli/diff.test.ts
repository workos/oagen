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
