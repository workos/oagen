import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractOperations } from '../../src/parser/operations.js';
import { parseSpec } from '../../src/parser/parse.js';

// Issue #289: the numeric suffix of the last resort was appended straight
// after a name that already ends in a digit, so the second of two names the
// root-words qualifier (#258) had versioned read as another version:
// `listV1` and `listV12`. On such a name the number now follows `No`
// (`listV1No2`); on a name ending in a letter it is still bare (`list2`).
// Every operation here is untagged unless it says otherwise, and each
// returns `200` with a JSON string, exactly as the issue's repro does.

type Paths = NonNullable<Parameters<typeof extractOperations>[0]>;

const ok = {
  responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } },
};
const get = { get: ok };
const param = (name: string, extra: Record<string, unknown> = {}) => ({
  parameters: [{ name, in: 'path' as const, required: true, schema: { type: 'string' } }],
  ...ok,
  ...extra,
});
const withParam = (name: string) => ({ get: param(name) });

/** The issue's own print-out: one entry per service, `name: METHOD /path` per operation. */
function services(paths: Paths) {
  return extractOperations(paths).services.map(({ name, operations }) => ({
    name,
    operations: operations.map(({ httpMethod, name, path }) => `${name}: ${httpMethod.toUpperCase()} ${path}`),
  }));
}

/** `METHOD /path` → `Service.name`, across every service. */
function names(paths: Paths): Record<string, string> {
  return Object.fromEntries(
    extractOperations(paths).services.flatMap((s) =>
      s.operations.map((op) => [`${op.httpMethod.toUpperCase()} ${op.path}`, `${s.name}.${op.name}`]),
    ),
  );
}

/** The same path items declared in the opposite order. */
function reversed(paths: Paths): Paths {
  return Object.fromEntries(Object.entries(paths).reverse());
}

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function writeSpec(paths: Paths): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oagen-numbered-names-'));
  dirs.push(dir);
  const file = path.join(dir, 'repro.json');
  await fs.writeFile(file, JSON.stringify({ openapi: '3.1.0', info: { title: 'repro', version: '1' }, paths }));
  return file;
}

describe('a numeric suffix on a name that ends in a digit (#289)', () => {
  const repro: Paths = { '/api': get, '/api/v1': get, '/api/v1/': get, '/api/v1/notes': get };

  it('sets the number off from the version with `No`, so the third `/api` path is listV1No2, not listV12', async () => {
    // The issue's print-out, through parseSpec exactly as the repro runs it.
    const spec = await parseSpec(await writeSpec(repro));
    expect(
      spec.services.map(({ name, operations }) => ({
        name,
        operations: operations.map(({ httpMethod, name, path }) => `${name}: ${httpMethod.toUpperCase()} ${path}`),
      })),
    ).toEqual([
      { name: 'Api', operations: ['list: GET /api', 'listV1: GET /api/v1', 'listV1No2: GET /api/v1/'] },
      { name: 'Notes', operations: ['list: GET /api/v1/notes'] },
    ]);
    // String bodies mint nothing, so there is nothing to dangle or orphan.
    expect(spec.models).toEqual([]);
    expect(spec.enums).toEqual([]);
    expect(names(reversed(repro))).toEqual(names(repro));
  });

  it('does the same for versioned paths that differ only in a parameter spelling', () => {
    // The issue's second repro: before #258 these were `V1.listNotes` and
    // `V1.listNotes2`; the version qualifier gives both `listV1`, and the
    // suffix must not turn the second into version 12.
    const paths: Paths = {
      '/api/{userId}/notes': withParam('userId'),
      '/api/v1/{userId}/notes': withParam('userId'),
      '/api/v1/{user_id}/notes': withParam('user_id'),
    };
    expect(names(paths)).toEqual({
      'GET /api/{userId}/notes': 'Notes.list',
      'GET /api/v1/{userId}/notes': 'Notes.listV1',
      'GET /api/v1/{user_id}/notes': 'Notes.listV1No2',
    });
    expect(names(reversed(paths))).toEqual(names(paths));
  });

  it('counts on behind `No` for every further collision, in path order', () => {
    // `{user-id}` sorts before `{userId}` and `{user_id}`, so it keeps the
    // plain versioned name; the other two take 2 and 3 in path order.
    const paths: Paths = {
      '/api/{userId}/notes': withParam('userId'),
      '/api/v1/{userId}/notes': withParam('userId'),
      '/api/v1/{user_id}/notes': withParam('user_id'),
      '/api/v1/{user-id}/notes': withParam('user-id'),
    };
    expect(names(paths)).toEqual({
      'GET /api/{userId}/notes': 'Notes.list',
      'GET /api/v1/{user-id}/notes': 'Notes.listV1',
      'GET /api/v1/{userId}/notes': 'Notes.listV1No2',
      'GET /api/v1/{user_id}/notes': 'Notes.listV1No3',
    });
    expect(names(reversed(paths))).toEqual(names(paths));
  });

  it('skips a `No` name another operation in the service already uses', () => {
    // The pool is one per service, so an operationId that spells
    // `listV1No2` holds it and the path-named operation steps to `No3`.
    const paths: Paths = {
      '/api/{userId}/notes': withParam('userId'),
      '/api/v1/{userId}/notes': withParam('userId'),
      '/api/v1/{user_id}/notes': { get: param('user_id'), post: param('user_id', { operationId: 'listV1No2' }) },
    };
    expect(names(paths)).toEqual({
      'GET /api/{userId}/notes': 'Notes.list',
      'GET /api/v1/{userId}/notes': 'Notes.listV1',
      'GET /api/v1/{user_id}/notes': 'Notes.listV1No3',
      'POST /api/v1/{user_id}/notes': 'Notes.listV1No2',
    });
  });

  it('applies to any name ending in a digit, not only a version: listTop10 and listTop10No2', () => {
    // The suffix itself predates #258; a path word that ends in a digit got
    // it the same way (`listTop102`).
    const paths: Paths = { '/pets/top10': get, '/pets/top10/': get };
    expect(names(paths)).toEqual({
      'GET /pets/top10': 'Pets.listTop10',
      'GET /pets/top10/': 'Pets.listTop10No2',
    });
    expect(names(reversed(paths))).toEqual(names(paths));
  });

  it('numbers a reused operationId that ends in a digit the same way, and says so in the warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const paths: Paths = {
        '/store/pets/{id}': { get: param('id', { operationId: 'getV2' }) },
        '/store/featured/{id}': { get: param('id', { operationId: 'getV2' }) },
      };
      // The lexically first path keeps the name the author chose.
      expect(names(paths)).toEqual({
        'GET /store/featured/{id}': 'Store.getV2',
        'GET /store/pets/{id}': 'Store.getV2No2',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /both take the name "getV2" from their operationId; the latter is renamed "getV2No2"/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('spells the number the same way on one path: a path-named PATCH beside operationId updateTop10 is updateTop10No2', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // demoteSamePathNames numbers a path-named operation whose CRUD name an
      // operationId holds on the same path, silently, through the same
      // function as the numeric pass across paths: the PATCH on
      // `/store/top10/{id}` is `updateTop10`, the name the PUT's operationId
      // holds, and it ends in a digit.
      expect(
        names({ '/store/top10/{id}': { put: param('id', { operationId: 'updateTop10' }), patch: param('id') } }),
      ).toEqual({
        'PUT /store/top10/{id}': 'Store.updateTop10',
        'PATCH /store/top10/{id}': 'Store.updateTop10No2',
      });
      expect(warn).not.toHaveBeenCalled();
      // An operationId the document reuses on one path is numbered the same
      // way, with the warning naming the new spelling.
      expect(
        names({
          '/store/top10/{id}': {
            put: param('id', { operationId: 'updateTop10' }),
            patch: param('id', { operationId: 'updateTop10' }),
          },
        }),
      ).toEqual({
        'PUT /store/top10/{id}': 'Store.updateTop10',
        'PATCH /store/top10/{id}': 'Store.updateTop10No2',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /both take the name "updateTop10" from their operationId; the latter is renamed "updateTop10No2"/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves the bare number on a name that ends in a letter', () => {
    // `/notes` beside `/api/v1/notes` differ only by the root: `list` and
    // `list2`, exactly as before.
    expect(names({ '/notes': get, '/api/v1/notes': get })).toEqual({
      'GET /notes': 'Notes.list',
      'GET /api/v1/notes': 'Notes.list2',
    });
  });

  it('gives no two operations in one service the same name', () => {
    const all: Paths = {
      ...repro,
      '/api/v1/{userId}/notes': withParam('userId'),
      '/api/v1/{user_id}/notes': withParam('user_id'),
      '/pets/top10': get,
      '/pets/top10/': get,
    };
    for (const { name, operations } of services(all)) {
      const ops = operations.map((line) => line.split(':')[0]);
      expect(new Set(ops).size, name).toBe(ops.length);
    }
  });
});
