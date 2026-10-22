import { describe, it, expect } from 'vitest';
import { extractOperations } from '../../src/parser/operations.js';

// Issue #287: since #258 the path-prefix split keyed an untagged operation on
// the segment after the API root and a tagged one on its raw first segment,
// so a tagged service that picked up one untagged operation by path had two
// keys, was split, and its tagged operations moved into a service named
// after the root. The split is now decided over the tag's own operations
// alone, and an untagged operation stays in the service its path named.
// Every operation here returns `200` with a JSON string, as the issue's
// repro does.

type Paths = NonNullable<Parameters<typeof extractOperations>[0]>;

const ok = {
  responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } },
};
const get = { get: ok };
const pathParam = (name: string) => ({ name, in: 'path' as const, required: true, schema: { type: 'string' } });
const tagged = (tag: string, extra: Record<string, unknown> = {}) => ({ get: { tags: [tag], ...ok, ...extra } });

/** The issue's own print-out: one entry per service, `name: METHOD /path` per operation. */
function services(paths: Paths) {
  return extractOperations(paths).services.map(({ name, operations }) => ({
    name,
    operations: operations.map(({ httpMethod, name, path }) => `${name}: ${httpMethod.toUpperCase()} ${path}`),
  }));
}

/** The same path items declared in the opposite order. */
function reversed(paths: Paths): Paths {
  return Object.fromEntries(Object.entries(paths).reverse());
}

describe('one untagged operation under a tagged service path leaves the tagged operations where they are', () => {
  const repro: Paths = {
    '/api/v1/notes': {
      get: { operationId: 'listNotes', tags: ['notes'], ...ok },
      post: { operationId: 'createNote', tags: ['notes'], ...ok },
    },
    '/api/v1/notes/{noteId}': {
      get: { operationId: 'getNote', tags: ['notes'], parameters: [pathParam('noteId')], ...ok },
    },
    '/api/v1/notes/{noteId}/export': { get: { parameters: [pathParam('noteId')], ...ok } },
  };

  it('keeps the issue repro in Notes, the untagged export beside the tagged operations', () => {
    expect(services(repro)).toEqual([
      {
        name: 'Notes',
        operations: [
          'listNotes: GET /api/v1/notes',
          'createNote: POST /api/v1/notes',
          'getNote: GET /api/v1/notes/{noteId}',
          'getNoteExport: GET /api/v1/notes/{noteId}/export',
        ],
      },
    ]);
  });

  it('does the same whatever the document order', () => {
    expect(services(reversed(repro))).toEqual([
      {
        name: 'Notes',
        operations: [
          'getNoteExport: GET /api/v1/notes/{noteId}/export',
          'getNote: GET /api/v1/notes/{noteId}',
          'listNotes: GET /api/v1/notes',
          'createNote: POST /api/v1/notes',
        ],
      },
    ]);
  });

  it('keeps the smallest form, a tagged /api/notes beside an untagged /api/v1/notes, in Notes', () => {
    const paths: Paths = { '/api/notes': tagged('notes'), '/api/v1/notes': get };
    const expected = [{ name: 'Notes', operations: ['listNotes: GET /api/notes', 'list: GET /api/v1/notes'] }];
    expect(services(paths)).toEqual(expected);
    expect(services(reversed(paths))).toEqual([
      { name: 'Notes', operations: ['list: GET /api/v1/notes', 'listNotes: GET /api/notes'] },
    ]);
  });

  it('places the tagged operations exactly where they go without the untagged one', () => {
    const taggedOnly: Paths = {
      '/api/v1/notes': repro['/api/v1/notes'],
      '/api/v1/notes/{noteId}': repro['/api/v1/notes/{noteId}'],
    };
    const withUntagged = services(repro);
    for (const { name, operations } of services(taggedOnly)) {
      const service = withUntagged.find((s) => s.name === name);
      expect(service, name).toBeDefined();
      for (const line of operations) expect(service!.operations).toContain(line);
    }
  });
});

describe('the split is decided over the tagged operations of each service alone', () => {
  it('still carves a tag that spans two first segments into one service per segment', () => {
    expect(
      services({ '/organizations': tagged('organizations'), '/organization_domains': tagged('organizations') }),
    ).toEqual([
      { name: 'Organizations', operations: ['list: GET /organizations'] },
      { name: 'OrganizationDomains', operations: ['list: GET /organization_domains'] },
    ]);
  });

  it('keeps an untagged operation in the service its path named when the tagged operations split', () => {
    const paths: Paths = {
      '/organizations': tagged('organizations'),
      '/organization_domains': tagged('organizations'),
      '/organizations/{id}/export': { get: { parameters: [pathParam('id')], ...ok } },
    };
    const expected = {
      Organizations: ['list: GET /organizations', 'getOrganizationExport: GET /organizations/{id}/export'],
      OrganizationDomains: ['list: GET /organization_domains'],
    };
    const byName = (p: Paths) => Object.fromEntries(services(p).map((s) => [s.name, [...s.operations].sort()]));
    expect(byName(paths)).toEqual(Object.fromEntries(Object.entries(expected).map(([n, ops]) => [n, [...ops].sort()])));
    expect(byName(reversed(paths))).toEqual(byName(paths));
  });

  it('moves only the tagged operations under another first segment, never the untagged one', () => {
    // The tag spans `/notes` and `/api/v1/notes`, so the rooted tagged
    // operation is split off to `Api` as it always was; the untagged one its
    // path named `Notes` stays there, whichever order the document uses.
    const paths: Paths = {
      '/notes': tagged('notes'),
      '/api/v1/notes': tagged('notes'),
      '/api/v1/notes/{noteId}/export': { get: { parameters: [pathParam('noteId')], ...ok } },
    };
    const byName = (p: Paths) => Object.fromEntries(services(p).map((s) => [s.name, [...s.operations].sort()]));
    expect(byName(paths)).toEqual({
      Notes: ['getNoteExport: GET /api/v1/notes/{noteId}/export', 'list: GET /notes'],
      Api: ['listNotes: GET /api/v1/notes'],
    });
    expect(byName(reversed(paths))).toEqual(byName(paths));
  });

  it('never lets operations a split moves into another tagged service re-split it', () => {
    // `organizations` spans two first segments and sends its
    // `/organization_domains` operation into `OrganizationDomains`, a tagged
    // service whose own operation sits under `/api`. That arrival must not
    // split `OrganizationDomains` and move its own operation to `Api` — which
    // is what happened when `OrganizationDomains` came later in the document.
    const paths: Paths = {
      '/organizations': tagged('organizations'),
      '/organization_domains': tagged('organizations'),
      '/api/organization_domains': tagged('organization_domains'),
    };
    const byName = (p: Paths) => Object.fromEntries(services(p).map((s) => [s.name, [...s.operations].sort()]));
    expect(byName(paths)).toEqual({
      Organizations: ['list: GET /organizations'],
      OrganizationDomains: [
        'list: GET /organization_domains',
        'listOrganizationDomains: GET /api/organization_domains',
      ],
    });
    expect(byName(reversed(paths))).toEqual(byName(paths));
  });

  it('keeps a tagged operation whose path has no first segment to be split on', () => {
    // `/` has no segment: it stays in its tag instead of founding a service
    // with an empty name, exactly as `/{id}` stays beside `/notes`.
    const paths: Paths = {
      '/': tagged('meta', { operationId: 'getRoot' }),
      '/{id}': tagged('meta', { operationId: 'getById', parameters: [pathParam('id')] }),
      '/meta/version': tagged('meta', { operationId: 'getVersion' }),
    };
    expect(services(paths)).toEqual([
      {
        name: 'Meta',
        operations: ['getRoot: GET /', 'getById: GET /{id}', 'getVersion: GET /meta/version'],
      },
    ]);
    expect(services(reversed(paths)).map((s) => s.name)).toEqual(['Meta']);
  });

  it('keeps untagged operations in Default, however their paths start', () => {
    const paths: Paths = {
      '/': { get: { operationId: 'getRoot', ...ok } },
      '/{id}': { get: { operationId: 'getById', parameters: [pathParam('id')], ...ok } },
    };
    expect(services(paths)).toEqual([{ name: 'Default', operations: ['getRoot: GET /', 'getById: GET /{id}'] }]);
  });
});
