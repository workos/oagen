import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseCommand } from '../../src/cli/parse.js';
import { diffCommand } from '../../src/cli/diff.js';
import type { ApiSpec } from '../../src/ir/types.js';

/**
 * `operationHints[...].pagination` from `oagen.config.ts` reaches the parser
 * through the commands that parse a spec (#221), so `oagen parse` and
 * `oagen diff` see the same pagination `oagen generate` does.
 */
describe('CLI — operationHints.pagination reaches the parser', () => {
  let tmpDir: string;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-cli-pagination-hint-'));
  });

  afterEach(async () => {
    log.mockClear();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const spec = (version: string, pageParam = 'page') => ({
    openapi: '3.1.0',
    info: { title: 'pets', version },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [
            { name: pageParam, in: 'query', schema: { type: 'integer' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      pets: { type: 'array', items: { type: 'string' } },
                      has_more: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  async function writeSpec(name: string, doc: unknown): Promise<string> {
    const file = path.join(tmpDir, name);
    await fs.writeFile(file, JSON.stringify(doc), 'utf-8');
    return file;
  }

  it('parse applies the hint over name-based detection', async () => {
    const file = await writeSpec('spec.json', spec('1'));
    await parseCommand({ spec: file });
    const detected = JSON.parse(log.mock.calls[0][0] as string) as ApiSpec;
    expect(detected.services[0].operations[0].pagination).toMatchObject({
      strategy: 'page',
      endOfIteration: { kind: 'hasMore', path: 'has_more' },
    });

    log.mockClear();
    await parseCommand({ spec: file, operationHints: { 'GET /pets': { pagination: { strategy: 'none' } } } });
    const hinted = JSON.parse(log.mock.calls[0][0] as string) as ApiSpec;
    expect(hinted.services[0].operations[0].pagination).toBeUndefined();
  });

  it('diff applies the hint to both specs, so a hinted strategy is not reported as a change', async () => {
    const oldFile = await writeSpec('old.json', spec('1'));
    const newFile = await writeSpec('new.json', spec('2'));
    const hints = { 'GET /pets': { pagination: { strategy: 'offset' as const } } };

    await expect(diffCommand({ old: oldFile, new: newFile, operationHints: hints })).rejects.toMatchObject({
      exitCode: 0,
    });
    const report = JSON.parse(log.mock.calls[0][0] as string);
    expect(report.changes).toEqual([]);
  });
});
