import { describe, it, expect, vi } from 'vitest';
import { extractOperations } from '../../src/parser/operations.js';

/**
 * Issue #288: a path-named operation gained a qualifier that told nothing
 * apart (`Teams`, from the middle of both `/org/teams/members` and
 * `/org/teams/{teamId}/members`), took a numeric suffix on a name a qualifier
 * had produced but another operation already had (`listArchivedMembers2`,
 * `listNotes2`), and lost a resource word because it matched the service word
 * rather than the service segment (`/teams/{id}/teams` in `Teams` was `list`,
 * then `listById`).
 */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Paths = Record<string, Partial<Record<Method, unknown>>>;

/** The issue's operations: untagged, `200` with a JSON string, path parameters declared. */
const json = {
  responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } },
};
const op = (...params: string[]) => ({
  ...json,
  parameters: params.map((name) => ({ name, in: 'path' as const, required: true, schema: { type: 'string' } })),
});
const withId = (operationId: string, ...params: string[]) => ({ ...op(...params), operationId });

/** The issue's own print-out: one entry per service, `name: METHOD /path` per operation. */
function services(paths: Paths) {
  return extractOperations(paths as Parameters<typeof extractOperations>[0]).services.map(({ name, operations }) => ({
    name,
    operations: operations.map((o) => `${o.name}: ${o.httpMethod.toUpperCase()} ${o.path}`),
  }));
}

/** `METHOD /path` → `Service.name`, across every service. */
function names(paths: Paths) {
  return Object.fromEntries(
    extractOperations(paths as Parameters<typeof extractOperations>[0]).services.flatMap((s) =>
      s.operations.map((o) => [`${o.httpMethod.toUpperCase()} ${o.path}`, `${s.name}.${o.name}`]),
    ),
  );
}

function reversed(paths: Paths): Paths {
  return Object.fromEntries(Object.entries(paths).reverse());
}

describe('path-named qualifiers (issue #288)', () => {
  const repro1: Paths = { '/org/teams/members': { get: json }, '/org/teams/{teamId}/members': { get: op('teamId') } };
  const repro2: Paths = {
    '/org/members/archived': { get: json },
    '/org/teams/archived': { get: json },
    '/org/archived_members': { get: json },
  };
  const repro2Noun: Paths = {
    '/api/notes': { get: json },
    '/api/{teamId}/notes': { get: withId('list', 'teamId') },
    '/api/{orgId}/notes': { get: withId('listNotes', 'orgId') },
  };
  const repro3: Paths = { '/teams': { get: json }, '/teams/{id}/teams': { get: op('id') } };

  it('1. does not add a word from the middle of the path that every colliding path carries', () => {
    // `Teams` sits in both paths — as `Teams` in one and, after `{teamId}`,
    // as the singular `Team` in the other, one noun either way — so it tells
    // nothing apart; only `By<Param>` does.
    expect(services(repro1)).toEqual([
      {
        name: 'Org',
        operations: ['listMembers: GET /org/teams/members', 'listMembersByTeamId: GET /org/teams/{teamId}/members'],
      },
    ]);
  });

  it('2. skips a qualified name another operation already has instead of numbering it', () => {
    // `/org/archived_members` is `listArchivedMembers` on its own; the deeper
    // context would give `/org/members/archived` the same name, so that one
    // is skipped and its twin takes `listArchivedTeams`, which leaves
    // `listArchived` to the first. Nothing is numbered.
    expect(services(repro2)).toEqual([
      {
        name: 'Org',
        operations: [
          'listArchived: GET /org/members/archived',
          'listArchivedTeams: GET /org/teams/archived',
          'listArchivedMembers: GET /org/archived_members',
        ],
      },
    ]);
  });

  it('2. does the same for the service noun: /api/notes is not a variant of operationId listNotes', () => {
    // The restored noun would be `listNotes`, which `operationId: listNotes`
    // on `/api/{orgId}/notes` holds, so it is skipped; with no qualifier left
    // the suffix goes on the plain name, as it did before #258.
    expect(services(repro2Noun)).toEqual([
      {
        name: 'Notes',
        operations: ['list2: GET /api/notes', 'list: GET /api/{teamId}/notes', 'listNotes: GET /api/{orgId}/notes'],
      },
    ]);
  });

  it('3. compares the resource with the service segment by position, not by word', () => {
    // `teams` at the end of `/teams/{id}/teams` is not the segment the
    // service was named from, so it is the resource: the two names never
    // collide and no `By<Param>` is needed.
    expect(services(repro3)).toEqual([
      { name: 'Teams', operations: ['list: GET /teams', 'listTeams: GET /teams/{id}/teams'] },
    ]);
  });

  it('keeps the nested collection for every method, its item singular, under an API root too', () => {
    expect(
      names({
        '/teams': { get: json, post: json },
        '/teams/{id}/teams': { get: op('id'), post: op('id') },
        '/teams/{id}/teams/{teamId}': { get: op('id', 'teamId'), delete: op('id', 'teamId') },
      }),
    ).toEqual({
      'GET /teams': 'Teams.list',
      'POST /teams': 'Teams.create',
      'GET /teams/{id}/teams': 'Teams.listTeams',
      'POST /teams/{id}/teams': 'Teams.createTeams',
      'GET /teams/{id}/teams/{teamId}': 'Teams.getTeam',
      'DELETE /teams/{id}/teams/{teamId}': 'Teams.deleteTeam',
    });
    expect(names({ '/api/v1/teams': { get: json }, '/api/v1/teams/{id}/teams': { get: op('id') } })).toEqual({
      'GET /api/v1/teams': 'Teams.list',
      'GET /api/v1/teams/{id}/teams': 'Teams.listTeams',
    });
  });

  it('skips the deeper context for the whole group when it says one thing in either number', () => {
    // `Cat` and `Cats` are one noun (#268 spells the parent of `{id}`
    // singular); the parameter is what tells the two apart.
    expect(
      names({
        '/store/cats/{id}/toys/{toyId}': { get: op('id', 'toyId') },
        '/store/cats/toys/{toyId}': { get: op('toyId') },
      }),
    ).toEqual({
      'GET /store/cats/{id}/toys/{toyId}': 'Store.getToyById',
      'GET /store/cats/toys/{toyId}': 'Store.getToy',
    });
  });

  it('keeps a deeper context that tells some members apart, on one spelling for those it does not', () => {
    // `Groups` and `Group` say the same thing, so the two group paths take
    // one spelling — the first in path order — and stay one group, which
    // `ByGroupId` then tells apart; `Teams` tells the third from them.
    expect(
      names({
        '/orgs/teams/members': { get: json },
        '/orgs/{orgId}/groups/members': { get: op('orgId') },
        '/orgs/{orgId}/groups/{groupId}/members': { get: op('orgId', 'groupId') },
      }),
    ).toEqual({
      'GET /orgs/teams/members': 'Orgs.listMembersTeams',
      'GET /orgs/{orgId}/groups/members': 'Orgs.listMembersGroups',
      'GET /orgs/{orgId}/groups/{groupId}/members': 'Orgs.listMembersGroupsByGroupId',
    });
    // Two members whose deeper context is the same word, spelled the same,
    // both take it and go on together, as before.
    expect(
      names({
        '/store/cats/{id}/toys/{toyId}': { get: op('id', 'toyId') },
        '/store/{storeId}/cats/{id}/toys/{toyId}': { get: op('storeId', 'id', 'toyId') },
        '/store/dogs/{id}/toys/{toyId}': { get: op('id', 'toyId') },
      }),
    ).toEqual({
      'GET /store/cats/{id}/toys/{toyId}': 'Store.getToyCat',
      'GET /store/{storeId}/cats/{id}/toys/{toyId}': 'Store.getToyCatByStoreId',
      'GET /store/dogs/{id}/toys/{toyId}': 'Store.getToyDog',
    });
  });

  it('joins the nested collection of the same word when the service path restores its noun beside an operationId', () => {
    // Review on #338: `/notes/{noteId}/notes` is `listNotes` on its own; when
    // `/notes` beside `operationId: list` needs `Notes` back, the two name one
    // noun and take one spelling, and the parameter tells them apart — the
    // service's own path keeps `listNotes` rather than `list2`.
    expect(
      names({
        '/notes': { get: json },
        '/notes/{noteId}/notes': { get: op('noteId') },
        '/api/v1/{orgId}/notes': { get: withId('list', 'orgId') },
      }),
    ).toEqual({
      'GET /notes': 'Notes.listNotes',
      'GET /notes/{noteId}/notes': 'Notes.listNotesByNoteId',
      'GET /api/v1/{orgId}/notes': 'Notes.list',
    });
    // Items the same, singular: `getNote` and `getNoteByChildId`.
    expect(
      names({
        '/notes/{noteId}': { get: op('noteId') },
        '/notes/{noteId}/notes/{childId}': { get: op('noteId', 'childId') },
        '/api/v1/{orgId}/notes/{noteId}': { get: withId('get', 'orgId', 'noteId') },
      }),
    ).toEqual({
      'GET /notes/{noteId}': 'Notes.getNote',
      'GET /notes/{noteId}/notes/{childId}': 'Notes.getNoteByChildId',
      'GET /api/v1/{orgId}/notes/{noteId}': 'Notes.get',
    });
    // Every nested collection of the word joins, each told apart by its own parameters.
    expect(
      names({
        '/notes': { get: json },
        '/notes/{noteId}/notes': { get: op('noteId') },
        '/notes/{noteId}/{x}/notes': { get: op('noteId', 'x') },
        '/api/v1/{orgId}/notes': { get: withId('list', 'orgId') },
      }),
    ).toEqual({
      'GET /notes': 'Notes.listNotes',
      'GET /notes/{noteId}/notes': 'Notes.listNotesByNoteId',
      'GET /notes/{noteId}/{x}/notes': 'Notes.listNotesByNoteIdByX',
      'GET /api/v1/{orgId}/notes': 'Notes.list',
    });
    // An operationId that holds the name is never joined: the service path
    // is numbered on its plain name, and the nested collection, which
    // collides with that operationId on its own, takes its parameter.
    expect(
      names({
        '/api/notes': { get: json },
        '/api/notes/{noteId}/notes': { get: op('noteId') },
        '/api/{teamId}/notes': { get: withId('list', 'teamId') },
        '/api/{orgId}/notes': { get: withId('listNotes', 'orgId') },
      }),
    ).toEqual({
      'GET /api/notes': 'Notes.list2',
      'GET /api/notes/{noteId}/notes': 'Notes.listNotesByNoteId',
      'GET /api/{teamId}/notes': 'Notes.list',
      'GET /api/{orgId}/notes': 'Notes.listNotes',
    });
    // Without an operationId to collide with, nothing is restored or joined.
    expect(names({ '/notes': { get: json }, '/notes/{noteId}/notes': { get: op('noteId') } })).toEqual({
      'GET /notes': 'Notes.list',
      'GET /notes/{noteId}/notes': 'Notes.listNotes',
    });
  });

  it('joins the nested collection only when a later pass tells the two apart (issue #402)', () => {
    // The issue repro. `/notes/notes` has nothing `/notes` lacks for a later
    // pass to read — no parameter, no root word, no segment between the
    // service and the resource, no plural — so joined at `listNotes` the two
    // would be numbered, and the nested collection that had the name would
    // be `listNotes2`. The name counts as taken instead, and the service's
    // own path is numbered on its plain name beside the operationId.
    const repro: Paths = {
      '/notes': { get: json },
      '/notes/notes': { get: json },
      '/notes/{noteId}/revisions': { get: withId('list', 'noteId') },
    };
    expect(services(repro)).toEqual([
      {
        name: 'Notes',
        operations: ['list2: GET /notes', 'listNotes: GET /notes/notes', 'list: GET /notes/{noteId}/revisions'],
      },
    ]);
    expect(names(reversed(repro))).toEqual(names(repro));
    // The name `/notes/notes` has without the operationId, which adding it leaves alone.
    expect(names({ '/notes': { get: json }, '/notes/notes': { get: json } })).toEqual({
      'GET /notes': 'Notes.list',
      'GET /notes/notes': 'Notes.listNotes',
    });
    // The same under an API root, for another method, and for a segment
    // between the service and the resource that repeats the noun the name
    // already ends with.
    expect(
      names({
        '/api/notes': { get: json },
        '/api/notes/notes': { get: json },
        '/api/notes/{noteId}/revisions': { get: withId('list', 'noteId') },
      }),
    ).toEqual({
      'GET /api/notes': 'Notes.list2',
      'GET /api/notes/notes': 'Notes.listNotes',
      'GET /api/notes/{noteId}/revisions': 'Notes.list',
    });
    expect(
      names({
        '/notes': { put: json },
        '/notes/notes': { put: json },
        '/notes/{noteId}/revisions': { put: withId('update', 'noteId') },
      }),
    ).toEqual({
      'PUT /notes': 'Notes.update2',
      'PUT /notes/notes': 'Notes.updateNotes',
      'PUT /notes/{noteId}/revisions': 'Notes.update',
    });
    expect(
      names({
        '/notes': { get: json },
        '/notes/notes/notes': { get: json },
        '/notes/{noteId}/revisions': { get: withId('list', 'noteId') },
      }),
    ).toEqual({
      'GET /notes': 'Notes.list2',
      'GET /notes/notes/notes': 'Notes.listNotes',
      'GET /notes/{noteId}/revisions': 'Notes.list',
    });
    // One holder no later pass can tell from `/notes` is enough to keep the
    // name taken, while the parameter still tells the other holder apart.
    expect(
      names({
        '/notes': { get: json },
        '/notes/notes': { get: json },
        '/notes/{noteId}/notes': { get: op('noteId') },
        '/notes/{noteId}/revisions': { get: withId('list', 'noteId') },
      }),
    ).toEqual({
      'GET /notes': 'Notes.list2',
      'GET /notes/notes': 'Notes.listNotes',
      'GET /notes/{noteId}/notes': 'Notes.listNotesByNoteId',
      'GET /notes/{noteId}/revisions': 'Notes.list',
    });
    // Whatever a later pass reads still joins, as before: a segment between
    // the service and the resource, a root word only one of them skipped, or
    // the plural only the nested item can take back.
    expect(
      names({
        '/notes': { get: json },
        '/notes/archive/notes': { get: json },
        '/notes/{noteId}/revisions': { get: withId('list', 'noteId') },
      }),
    ).toEqual({
      'GET /notes': 'Notes.listNotes',
      'GET /notes/archive/notes': 'Notes.listNotesArchive',
      'GET /notes/{noteId}/revisions': 'Notes.list',
    });
    expect(
      names({
        '/api/notes': { get: json },
        '/api/v1/notes/notes': { get: json },
        '/api/notes/{noteId}/revisions': { get: withId('list', 'noteId') },
      }),
    ).toEqual({
      'GET /api/notes': 'Notes.listNotes',
      'GET /api/v1/notes/notes': 'Notes.listNotesV1',
      'GET /api/notes/{noteId}/revisions': 'Notes.list',
    });
    expect(
      names({
        '/notes/{noteId}': { get: op('noteId') },
        '/notes/notes/{noteId}': { get: op('noteId') },
        '/notes/{noteId}/revisions/{revisionId}': { get: withId('get', 'noteId', 'revisionId') },
      }),
    ).toEqual({
      'GET /notes/{noteId}': 'Notes.getNote',
      'GET /notes/notes/{noteId}': 'Notes.getNotes',
      'GET /notes/{noteId}/revisions/{revisionId}': 'Notes.get',
    });
    // But not when the name that pass would give is taken: beside
    // `operationId: listNotesByNoteId` the parameter has nothing left to give
    // `/notes/{noteId}/notes`, which keeps `listNotes`, and beside
    // `operationId: getNotes` the nested item keeps `getNote`.
    expect(
      names({
        '/notes': { get: json },
        '/notes/{noteId}/notes': { get: op('noteId') },
        '/api/v1/{orgId}/notes': { get: withId('list', 'orgId') },
        '/notes/{noteId}/pinned': { post: withId('listNotesByNoteId', 'noteId') },
      }),
    ).toEqual({
      'GET /notes': 'Notes.list2',
      'GET /notes/{noteId}/notes': 'Notes.listNotes',
      'GET /api/v1/{orgId}/notes': 'Notes.list',
      'POST /notes/{noteId}/pinned': 'Notes.listNotesByNoteId',
    });
    expect(
      names({
        '/notes/{noteId}': { get: op('noteId') },
        '/notes/notes/{noteId}': { get: op('noteId') },
        '/notes/{noteId}/revisions/{revisionId}': { get: withId('get', 'noteId', 'revisionId') },
        '/notes/pinned/{noteId}': { get: withId('getNotes', 'noteId') },
      }),
    ).toEqual({
      'GET /notes/{noteId}': 'Notes.get2',
      'GET /notes/notes/{noteId}': 'Notes.getNote',
      'GET /notes/{noteId}/revisions/{revisionId}': 'Notes.get',
      'GET /notes/pinned/{noteId}': 'Notes.getNotes',
    });
  });

  it('skips a By<Param> name an operationId holds, and numbers the plain name only when nothing is left', () => {
    expect(
      names({
        '/v1/notes': { get: json },
        '/v1/{teamId}/notes': { get: op('teamId') },
        '/v1/notes/other': { get: withId('listByTeamId') },
      }),
    ).toEqual({
      'GET /v1/notes': 'Notes.list',
      'GET /v1/{teamId}/notes': 'Notes.list2',
      'GET /v1/notes/other': 'Notes.listByTeamId',
    });
    // Both deeper contexts taken: the suffix goes on the plain name, never on
    // a name that reads as a variant of an unrelated path.
    expect(names({ ...repro2, '/org/archived_teams': { get: json } })).toEqual({
      'GET /org/members/archived': 'Org.listArchived',
      'GET /org/teams/archived': 'Org.listArchived2',
      'GET /org/archived_members': 'Org.listArchivedMembers',
      'GET /org/archived_teams': 'Org.listArchivedTeams',
    });
  });

  it('gives plural twins the plural together beside an operationId, so the number lands on the twin', () => {
    expect(
      names({
        '/store/pets/{id}': { get: op('id') },
        '/store/Pets/{id}': { get: op('id') },
        '/store/featured/{id}': { get: withId('getPet', 'id') },
      }),
    ).toEqual({
      'GET /store/pets/{id}': 'Store.getPets2',
      'GET /store/Pets/{id}': 'Store.getPets',
      'GET /store/featured/{id}': 'Store.getPet',
    });
  });

  it('shares a spelling between PUT and PATCH on one path', () => {
    expect(
      names({
        '/org/teams/members': { put: json, patch: json },
        '/org/teams/{teamId}/members': { put: op('teamId') },
      }),
    ).toEqual({
      'PUT /org/teams/members': 'Org.updateMembers',
      'PATCH /org/teams/members': 'Org.updateMembers',
      'PUT /org/teams/{teamId}/members': 'Org.updateMembersByTeamId',
    });
  });

  it('gives every shape unique, order-independent names without a warning', () => {
    const shapes: Paths[] = [
      repro1,
      repro2,
      repro2Noun,
      repro3,
      { ...repro2, '/org/archived_teams': { get: json } },
      {
        '/orgs/teams/members': { get: json },
        '/orgs/{orgId}/groups/members': { get: op('orgId') },
        '/orgs/{orgId}/groups/{groupId}/members': { get: op('orgId', 'groupId') },
      },
      {
        '/notes': { get: json },
        '/notes/{noteId}/notes': { get: op('noteId') },
        '/notes/{noteId}/{x}/notes': { get: op('noteId', 'x') },
        '/api/v1/{orgId}/notes': { get: withId('list', 'orgId') },
      },
      {
        '/api/notes': { get: json },
        '/api/notes/{noteId}/notes': { get: op('noteId') },
        '/api/{teamId}/notes': { get: withId('list', 'teamId') },
        '/api/{orgId}/notes': { get: withId('listNotes', 'orgId') },
      },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const shape of shapes) {
        for (const { name, operations } of extractOperations(shape as Parameters<typeof extractOperations>[0])
          .services) {
          const byPath = new Map<string, string>();
          for (const o of operations) {
            // PUT + PATCH on one path may share a name; different paths never do.
            const owner = byPath.get(o.name);
            expect(owner === undefined || owner === o.path, `${name}.${o.name}`).toBe(true);
            byPath.set(o.name, o.path);
          }
        }
        expect(names(reversed(shape))).toEqual(names(shape));
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
