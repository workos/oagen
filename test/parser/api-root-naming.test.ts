import { describe, it, expect, vi } from 'vitest';
import { extractOperations } from '../../src/parser/operations.js';

// Issue #250: four ways untagged operations under a shared API root (#224)
// still got the wrong name after the collision rules of #227. Every
// operation here is untagged unless it says otherwise, and each returns
// `200` with a JSON string, exactly as the issue's repro does.

type Paths = NonNullable<Parameters<typeof extractOperations>[0]>;

const ok = {
  responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } },
};
const get = { get: ok };
const withParam = (name: string, extra: Record<string, unknown> = {}) => ({
  parameters: [{ name, in: 'path' as const, required: true, schema: { type: 'string' } }],
  ...ok,
  ...extra,
});

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

describe('1. a path-prefix split keyed on the raw first segment separated operations already named for one service', () => {
  const repro: Paths = { '/notes': get, '/pets': get, '/api/v1/notes': get, '/api/v1/pets': get };

  it('keeps /api/v1/notes beside /notes in Notes, where the collision rules see both', () => {
    // The split keys on the segment the service was named from, so nothing
    // moves to `Api`; the two paths differ only by the root and flatten to
    // the same words, so the root-less path keeps the plain name it has
    // always had and the rooted one takes the suffix.
    expect(services(repro)).toEqual([
      { name: 'Notes', operations: ['list: GET /notes', 'list2: GET /api/v1/notes'] },
      { name: 'Pets', operations: ['list: GET /pets', 'list2: GET /api/v1/pets'] },
    ]);
    expect(names(reversed(repro))).toEqual(names(repro));
  });

  it('leaves the plain name with a path outside the root, whatever the document order', () => {
    // Review on #258: /health kept `Health.list` on main and must not lose it
    // to /api/health, which sorts first lexically.
    const paths: Paths = { '/health': get, '/api/health': get, '/api/v1/notes': get };
    expect(names(paths)).toEqual({
      'GET /health': 'Health.list',
      'GET /api/health': 'Health.list2',
      'GET /api/v1/notes': 'Notes.list',
    });
    expect(names(reversed(paths))).toEqual(names(paths));
  });

  it('leaves the plain name with a tagged operation, whatever the document order', () => {
    // A tagged service is named exactly as before: `Notes.list` for the
    // tagged /notes, with the untagged rooted twin taking the suffix.
    const notes = { get: { tags: ['notes'], ...ok } };
    const paths: Paths = { '/notes': notes, '/api/v1/notes': get, '/api/v1/pets': get };
    expect(names(paths)).toEqual({
      'GET /notes': 'Notes.list',
      'GET /api/v1/notes': 'Notes.list2',
      'GET /api/v1/pets': 'Pets.list',
    });
    expect(names(reversed(paths))).toEqual(names(paths));
  });

  it('qualifies a versioned path with the root words its versionless twin did not skip', () => {
    // Review on #258: /api/notes beside /api/v1/notes were Notes.list and
    // V1.listNotes on main; the version is what tells them apart, so it is
    // the one root word that belongs in the name.
    const paths: Paths = { '/api/notes': get, '/api/v1/notes': get, '/api/v1/pets': get };
    expect(names(paths)).toEqual({
      'GET /api/notes': 'Notes.list',
      'GET /api/v1/notes': 'Notes.listV1',
      'GET /api/v1/pets': 'Pets.list',
    });
    expect(names(reversed(paths))).toEqual(names(paths));
    // A root-less path still takes no part: it keeps `list`, the versionless
    // rooted twin takes the suffix, and the versioned one its root word.
    expect(names({ '/notes': get, '/api/notes': get, '/api/v1/notes': get })).toEqual({
      'GET /notes': 'Notes.list',
      'GET /api/notes': 'Notes.list2',
      'GET /api/v1/notes': 'Notes.listV1',
    });
  });

  it('gives no two operations in one service the same name', () => {
    for (const { name, operations } of services(repro)) {
      const ops = operations.map((line) => line.split(':')[0]);
      expect(new Set(ops).size, name).toBe(ops.length);
    }
  });

  it('still splits a tagged service by raw first segment', () => {
    const organizations = { get: { tags: ['organizations'], ...ok } };
    expect(services({ '/organizations': organizations, '/organization_domains': organizations })).toEqual([
      { name: 'Organizations', operations: ['list: GET /organizations'] },
      { name: 'OrganizationDomains', operations: ['list: GET /organization_domains'] },
    ]);
    // A tagged operation whose first segment differs is carved out as
    // before; the untagged one stays in the service it was named for.
    const notes = { get: { tags: ['notes'], ...ok } };
    expect(services({ '/x/notes': notes, '/api/v1/notes': get })).toEqual([
      { name: 'X', operations: ['listNotes: GET /x/notes'] },
      { name: 'Notes', operations: ['list: GET /api/v1/notes'] },
    ]);
  });
});

describe('2. a path-named operation that clashes with an operationId name is the one renamed', () => {
  const repro: Paths = {
    '/api/notes': get,
    '/api/{teamId}/notes': { get: withParam('teamId', { operationId: 'list' }) },
  };

  it('restores the resource noun to the path-named operation and keeps the operationId as written', () => {
    expect(services(repro)).toEqual([
      { name: 'Notes', operations: ['listNotes: GET /api/notes', 'list: GET /api/{teamId}/notes'] },
    ]);
  });

  it('does the same when the operationId-named operation comes first', () => {
    expect(names(reversed(repro))).toEqual(names(repro));
  });

  it('does the same for an item operation whose parameters the operationId path shares', () => {
    expect(
      names({
        '/api/notes/{noteId}': { get: withParam('noteId') },
        '/api/{teamId}/notes/{noteId}': { get: withParam('teamId', { operationId: 'get' }) },
      }),
    ).toEqual({
      'GET /api/notes/{noteId}': 'Notes.getNotes',
      'GET /api/{teamId}/notes/{noteId}': 'Notes.get',
    });
  });

  it('prefers a parameter of its own over the restored noun', () => {
    expect(
      names({
        '/api/{teamId}/notes': { get: withParam('teamId') },
        '/api/notes': { get: { operationId: 'list', ...ok } },
      }),
    ).toEqual({
      'GET /api/{teamId}/notes': 'Notes.listByTeamId',
      'GET /api/notes': 'Notes.list',
    });
  });

  it('never rewrites a name that came from an operationId, even when the path-named one has nothing left to add', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Root-less: the noun is already in the name, so the numeric suffix is
      // what remains, exactly as #227 pinned it.
      expect(
        names({
          '/x/notes': get,
          '/x/{teamId}/notes': { get: withParam('teamId', { operationId: 'listNotes' }) },
        }),
      ).toEqual({
        'GET /x/notes': 'X.listNotes2',
        'GET /x/{teamId}/notes': 'X.listNotes',
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('3. a path without a version no longer shortens the root for every path', () => {
  it('leaves the versioned paths in Notes and Pets and /api/openapi.json in its own service', () => {
    expect(services({ '/api/v1/notes': get, '/api/v1/pets': get, '/api/openapi.json': get })).toEqual([
      { name: 'Notes', operations: ['list: GET /api/v1/notes'] },
      { name: 'Pets', operations: ['list: GET /api/v1/pets'] },
      { name: 'OpenapiJson', operations: ['list: GET /api/openapi.json'] },
    ]);
  });

  it('does the same for /api/admin/users and /api/internal/status', () => {
    expect(services({ '/api/v1/notes': get, '/api/v1/pets': get, '/api/admin/users': get })).toEqual([
      { name: 'Notes', operations: ['list: GET /api/v1/notes'] },
      { name: 'Pets', operations: ['list: GET /api/v1/pets'] },
      { name: 'Admin', operations: ['listUsers: GET /api/admin/users'] },
    ]);
    expect(names({ '/api/v1/notes': get, '/api/internal/status': get })).toEqual({
      'GET /api/v1/notes': 'Notes.list',
      'GET /api/internal/status': 'Internal.listStatus',
    });
  });

  it('skips only the path`s own root, however the document is ordered', () => {
    const paths: Paths = { '/api/openapi.json': get, '/api/v1/notes': get, '/api/v1/pets': get };
    expect(names(paths)).toEqual({
      'GET /api/openapi.json': 'OpenapiJson.list',
      'GET /api/v1/notes': 'Notes.list',
      'GET /api/v1/pets': 'Pets.list',
    });
    expect(names(reversed(paths))).toEqual(names(paths));
  });

  it('still shortens the root to /api when a second version disagrees with the first', () => {
    expect(names({ '/api/v1/notes': get, '/api/v2/notes': get, '/api/openapi.json': get })).toEqual({
      'GET /api/v1/notes': 'V1.listNotes',
      'GET /api/v2/notes': 'V2.listNotes',
      'GET /api/openapi.json': 'OpenapiJson.list',
    });
  });

  it('keeps a marker-less path outside the root, and two roots that disagree, exactly as before', () => {
    expect(names({ '/api/v1/notes': get, '/openapi.json': get })).toEqual({
      'GET /api/v1/notes': 'Notes.list',
      'GET /openapi.json': 'OpenapiJson.list',
    });
    // `/rest` is a root of its own, not a prefix of `api/v1`, so there is no shared root.
    expect(names({ '/api/v1/notes': get, '/rest/legacy': get })).toEqual({
      'GET /api/v1/notes': 'Api.listNotes',
      'GET /rest/legacy': 'Rest.listLegacy',
    });
  });
});

describe('4. By<Param> qualifies with only the parameters that differ between the clashing paths', () => {
  it('names the issue repro get and getByTeamId', () => {
    expect(
      services({
        '/api/notes/{noteId}': { get: withParam('noteId') },
        '/api/{teamId}/notes/{noteId}': { get: withParam('teamId') },
      }),
    ).toEqual([
      {
        name: 'Notes',
        operations: ['get: GET /api/notes/{noteId}', 'getByTeamId: GET /api/{teamId}/notes/{noteId}'],
      },
    ]);
  });

  it('drops a parameter shared by every path of a three-way clash and keeps the rest in path order', () => {
    expect(
      names({
        '/api/{orgId}/notes/{noteId}': { get: withParam('orgId') },
        '/api/{orgId}/{teamId}/notes/{noteId}': { get: withParam('orgId') },
        '/api/{orgId}/{teamId}/{userId}/notes/{noteId}': { get: withParam('orgId') },
      }),
    ).toEqual({
      'GET /api/{orgId}/notes/{noteId}': 'Notes.get',
      'GET /api/{orgId}/{teamId}/notes/{noteId}': 'Notes.getByTeamId',
      'GET /api/{orgId}/{teamId}/{userId}/notes/{noteId}': 'Notes.getByTeamIdByUserId',
    });
  });

  it('compares parameters by their spelled word, so {team_id} and {teamId} are one parameter', () => {
    expect(
      names({
        '/api/{team_id}/notes/{noteId}': { get: withParam('team_id') },
        '/api/{teamId}/{orgId}/notes/{noteId}': { get: withParam('teamId') },
      }),
    ).toEqual({
      'GET /api/{team_id}/notes/{noteId}': 'Notes.get',
      'GET /api/{teamId}/{orgId}/notes/{noteId}': 'Notes.getByOrgId',
    });
  });

  it('falls through to the numeric suffix when the paths share every parameter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        names({
          '/api/{id}/notes/{x}': { get: withParam('id') },
          '/api/{id}/Notes/{x}': { get: withParam('id') },
        }),
      ).toEqual({
        'GET /api/{id}/Notes/{x}': 'Notes.get',
        'GET /api/{id}/notes/{x}': 'Notes.get2',
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('every service has unique, order-independent operation names across the shapes the root rule meets', () => {
  const opId = (operationId: string) => ({ get: { operationId, ...ok } });
  const tagged = (tag: string) => ({ get: { tags: [tag], ...ok } });

  const matrix: Record<string, Paths> = {
    'shared root with two versions': {
      '/api/v1/notes': get,
      '/api/v1/notes/{id}': { get: withParam('id') },
      '/api/v2/notes': get,
      '/api/v2/notes/{id}': { get: withParam('id') },
      '/api/v2/pets': get,
    },
    'a versionless path beside versioned ones': {
      '/api/v1/notes': get,
      '/api/v1/pets': get,
      '/api/openapi.json': get,
      '/api/admin/users': get,
      '/api/admin/users/{id}': { get: withParam('id') },
    },
    // The tagged pair is carved out of `Notes` into `Api` by the split, which
    // keys a tagged operation on its raw first segment as it always has; the
    // untagged ones now stay in `Notes` instead of following it there.
    'tagged and untagged under one root': {
      '/api/notes': tagged('notes'),
      '/api/notes/{id}': tagged('notes'),
      '/api/v1/notes': get,
      '/api/v1/notes/{id}': { get: withParam('id') },
      '/notes': get,
      '/health': tagged('ops'),
    },
    'operationId and path-named clash without parameters': {
      '/api/notes': get,
      '/api/{teamId}/notes': { get: withParam('teamId', { operationId: 'list' }) },
      '/api/pets': opId('list'),
      '/api/{teamId}/pets': { get: withParam('teamId') },
    },
    'operationId and path-named clash with parameters': {
      '/api/notes/{noteId}': { get: withParam('noteId') },
      '/api/{teamId}/notes/{noteId}': { get: withParam('teamId', { operationId: 'get' }) },
      '/api/pets/{petId}': { get: withParam('petId', { operationId: 'get' }) },
      '/api/{teamId}/pets/{petId}': { get: withParam('teamId') },
    },
    'three-way clashes': {
      '/api/notes': get,
      '/api/{teamId}/notes': { get: withParam('teamId') },
      '/api/{orgId}/notes': { get: withParam('orgId') },
      '/pets': get,
      '/api/v1/pets': get,
      '/api/v1/{teamId}/pets': { get: withParam('teamId') },
    },
    'paths sharing all of their parameters': {
      '/api/{id}/notes': { get: withParam('id') },
      '/api/{id}/Notes': { get: withParam('id') },
      '/api/notes/{noteId}': { get: withParam('noteId') },
      '/api/{teamId}/notes/{noteId}': { get: withParam('teamId') },
      '/api/{team_id}/notes/{note_id}': { get: withParam('team_id') },
    },
    'the root itself and a parameter right after it': {
      '/api': get,
      '/api/{id}': { get: withParam('id') },
      '/api/v1/{id}': { get: withParam('id') },
      '/api/v1/notes': get,
      '/api/v1/notes/{id}': { get: withParam('id') },
    },
  };

  for (const [shape, paths] of Object.entries(matrix)) {
    it(`${shape}: no two operations in a service share a name`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (const { name, operations } of extractOperations(paths).services) {
          const byPath = new Map<string, string>();
          for (const op of operations) {
            // PUT + PATCH on one path may share a name; different paths never do.
            const owner = byPath.get(op.name);
            expect(owner === undefined || owner === op.path, `${name}.${op.name}`).toBe(true);
            byPath.set(op.name, op.path);
          }
        }
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it(`${shape}: the names do not depend on the document order`, () => {
      expect(names(reversed(paths))).toEqual(names(paths));
    });
  }

  it('pins the matrix so a change in any rule is visible', () => {
    expect(Object.fromEntries(Object.entries(matrix).map(([shape, paths]) => [shape, names(paths)])))
      .toMatchInlineSnapshot(`
        {
          "a versionless path beside versioned ones": {
            "GET /api/admin/users": "Admin.listUsers",
            "GET /api/admin/users/{id}": "Admin.getUser",
            "GET /api/openapi.json": "OpenapiJson.list",
            "GET /api/v1/notes": "Notes.list",
            "GET /api/v1/pets": "Pets.list",
          },
          "operationId and path-named clash with parameters": {
            "GET /api/notes/{noteId}": "Notes.getNotes",
            "GET /api/pets/{petId}": "Pets.get",
            "GET /api/{teamId}/notes/{noteId}": "Notes.get",
            "GET /api/{teamId}/pets/{petId}": "Pets.getByTeamId",
          },
          "operationId and path-named clash without parameters": {
            "GET /api/notes": "Notes.listNotes",
            "GET /api/pets": "Pets.list",
            "GET /api/{teamId}/notes": "Notes.list",
            "GET /api/{teamId}/pets": "Pets.listByTeamId",
          },
          "paths sharing all of their parameters": {
            "GET /api/notes/{noteId}": "Notes.get",
            "GET /api/{id}/Notes": "Notes.list",
            "GET /api/{id}/notes": "Notes.list2",
            "GET /api/{teamId}/notes/{noteId}": "Notes.getByTeamId",
            "GET /api/{team_id}/notes/{note_id}": "Notes.getByTeamId2",
          },
          "shared root with two versions": {
            "GET /api/v1/notes": "V1.listNotes",
            "GET /api/v1/notes/{id}": "V1.getNote",
            "GET /api/v2/notes": "V2.listNotes",
            "GET /api/v2/notes/{id}": "V2.getNote",
            "GET /api/v2/pets": "V2.listPets",
          },
          "tagged and untagged under one root": {
            "GET /api/notes": "Api.listNotes",
            "GET /api/notes/{id}": "Api.getNote",
            "GET /api/v1/notes": "Notes.list2",
            "GET /api/v1/notes/{id}": "Notes.get",
            "GET /health": "Ops.list",
            "GET /notes": "Notes.list",
          },
          "the root itself and a parameter right after it": {
            "GET /api": "Api.list",
            "GET /api/v1/notes": "Notes.list",
            "GET /api/v1/notes/{id}": "Notes.get",
            "GET /api/v1/{id}": "Api.getV1",
            "GET /api/{id}": "Api.get",
          },
          "three-way clashes": {
            "GET /api/notes": "Notes.list",
            "GET /api/v1/pets": "Pets.list2",
            "GET /api/v1/{teamId}/pets": "Pets.listByTeamId",
            "GET /api/{orgId}/notes": "Notes.listByOrgId",
            "GET /api/{teamId}/notes": "Notes.listByTeamId",
            "GET /pets": "Pets.list",
          },
        }
      `);
  });
});
