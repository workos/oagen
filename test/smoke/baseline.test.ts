import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec, type OpenApiDocument } from '../../src/parser/parse.js';
import type { SmokeResults } from '../../scripts/smoke/shared.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = path.resolve(ROOT, 'node_modules/.bin/tsx');
const BASELINE = path.resolve(ROOT, 'scripts/smoke/baseline.ts');
const execFileAsync = promisify(execFile);

/**
 * #567: `oagen verify` hands the script the IR it parsed as `--ir`, so the
 * baseline lists the operations `generate` reads. Without it the script
 * parses `--spec` bare, which no config setting reaches.
 */
describe('scripts/smoke/baseline.ts', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  /** Run the script in `dir` and read back the operations it listed. */
  async function baselineIn(dir: string, args: string[]): Promise<string[]> {
    await execFileAsync(TSX, [BASELINE, ...args], {
      cwd: dir,
      env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', OPENAPI_SPEC_PATH: undefined, SMOKE_CONFIG: undefined },
    });
    const results = JSON.parse(
      readFileSync(path.join(dir, 'smoke-results-spec-baseline.json'), 'utf-8'),
    ) as SmokeResults;
    return results.exchanges.map((e) => `${e.operationId} ${e.request.method} ${e.request.path}`);
  }

  it('lists the operations of the IR handed as --ir, else those of --spec parsed bare', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-smoke-baseline-'));
    dirs.push(dir);
    const ok = (schema: unknown) => ({ '200': { description: 'ok', content: { 'application/json': { schema } } } });
    const spec = path.join(dir, 'pets-controller.json');
    await fs.writeFile(
      spec,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'pets', version: '1' },
        tags: [{ name: 'Pets' }],
        paths: {
          '/pets': {
            get: {
              operationId: 'PetsController_list',
              tags: ['Pets'],
              responses: ok({ type: 'array', items: { $ref: '#/components/schemas/Pet' } }),
            },
          },
          '/pets/{id}': {
            get: {
              operationId: 'PetsController_get',
              tags: ['Pets'],
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: ok({ $ref: '#/components/schemas/Pet' }),
            },
          },
        },
        components: {
          schemas: { Pet: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
        },
      }),
    );

    expect(await baselineIn(dir, ['--spec', spec])).toEqual([
      'Pets.petsControllerList GET /pets',
      'Pets.petsControllerGet GET /pets/<ID>',
    ]);

    // The IR `verify` parses with the config's settings: the ids stripped of
    // `PetsController_`, `/pets/{id}` dropped by `transformSpec`.
    const ir = path.join(dir, 'spec-ir.json');
    const parsed = await parseSpec(spec, {
      operationIdTransform: (id) => (id.startsWith('PetsController_') ? id.slice('PetsController_'.length) : id),
      transformSpec: (d: OpenApiDocument) => {
        delete (d.paths as Record<string, unknown>)['/pets/{id}'];
        return d;
      },
    });
    await fs.writeFile(ir, JSON.stringify(parsed));
    expect(await baselineIn(dir, ['--spec', spec, '--ir', ir])).toEqual(['Pets.list GET /pets']);
  }, 30_000);
});
