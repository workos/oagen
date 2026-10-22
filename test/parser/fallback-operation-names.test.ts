import { describe, it, expect, vi } from 'vitest';
import { extractOperations } from '../../src/parser/operations.js';

/**
 * Fallback operation names — the `<verb><Resource>` an operation gets when it
 * has no `operationId` (issue #210): the resource of an item operation is
 * singular, and a POST to a literal after an item parameter is an action.
 */

const ok = { responses: { '204': { description: 'ok' } } };
const idParam = (name: string) => ({
  parameters: [{ name, in: 'path' as const, required: true, schema: { type: 'string' } }],
});
const item = (name: string) => ({ ...ok, ...idParam(name) });

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';

/** `name METHOD path` for every operation, sorted by path (code units) then method. */
function names(paths: Record<string, Partial<Record<Method, unknown>>>) {
  const { services } = extractOperations(paths as Parameters<typeof extractOperations>[0]);
  const key = (op: { path: string; httpMethod: string }) => `${op.path}\0${op.httpMethod}`;
  return services
    .flatMap((s) => s.operations)
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .map((op) => `${op.name.padEnd(28)} ${op.httpMethod.toUpperCase().padEnd(6)} ${op.path}`);
}

describe('fallback operation names (issue #210)', () => {
  it('names the issue repro: singular item, action verb with its parent', () => {
    const result = names({
      '/store/pets': { get: ok },
      '/store/pets/{petId}': { get: item('petId') },
      '/store/pets/{petId}/adopt': { post: item('petId') },
    });
    expect(result).toMatchInlineSnapshot(`
      [
        "listPets                     GET    /store/pets",
        "getPet                       GET    /store/pets/{petId}",
        "adoptPet                     POST   /store/pets/{petId}/adopt",
      ]
    `);
  });

  it('singularises the resource of an item operation for every HTTP method', () => {
    const result = names({
      '/store/pets/{petId}': {
        get: item('petId'),
        put: item('petId'),
        patch: item('petId'),
        delete: item('petId'),
        head: item('petId'),
        post: item('petId'),
      },
    });
    expect(result).toEqual([
      'deletePet                    DELETE /store/pets/{petId}',
      'getPet                       GET    /store/pets/{petId}',
      'checkPet                     HEAD   /store/pets/{petId}',
      'updatePet                    PATCH  /store/pets/{petId}',
      'createPet                    POST   /store/pets/{petId}',
      'updatePet                    PUT    /store/pets/{petId}',
    ]);
  });

  it('keeps a collection plural, and a POST to it or below it a create', () => {
    const result = names({
      '/store/pets': { get: ok, post: ok },
      // A literal under a collection with no parameter before it cannot be told
      // from a nested collection such as /accounts/users/auth_factors.
      '/store/pets/search': { post: ok },
      '/store/pets/{petId}/photos': { get: item('petId'), post: item('petId') },
    });
    expect(result).toEqual([
      'listPets                     GET    /store/pets',
      'createPets                   POST   /store/pets',
      'createSearch                 POST   /store/pets/search',
      'listPhotos                   GET    /store/pets/{petId}/photos',
      'createPhotos                 POST   /store/pets/{petId}/photos',
    ]);
  });

  it('handles nested items and a POST action under a nested item', () => {
    const result = names({
      '/owners/{ownerId}/pets': { get: item('ownerId'), post: item('ownerId') },
      '/owners/{ownerId}/pets/{petId}': { get: item('ownerId'), delete: item('ownerId') },
      '/owners/{ownerId}/pets/{petId}/vaccinate': { post: item('ownerId') },
    });
    expect(result).toEqual([
      'listPets                     GET    /owners/{ownerId}/pets',
      'createPets                   POST   /owners/{ownerId}/pets',
      'deletePet                    DELETE /owners/{ownerId}/pets/{petId}',
      'getPet                       GET    /owners/{ownerId}/pets/{petId}',
      'vaccinatePet                 POST   /owners/{ownerId}/pets/{petId}/vaccinate',
    ]);
  });

  it('drops the service segment from a CRUD name but keeps it as the parent of an action', () => {
    const result = names({
      '/pets': { post: ok },
      '/pets/{petId}': { get: item('petId') },
      '/pets/{petId}/adopt': { post: item('petId') },
    });
    expect(result).toEqual([
      'create                       POST   /pets',
      'get                          GET    /pets/{petId}',
      'adoptPet                     POST   /pets/{petId}/adopt',
    ]);
  });

  it('does not collide two same-named actions on different resources in one service', () => {
    const tagged = (name: string) => ({ ...item(name), tags: ['admin'] });
    const result = names({
      '/pets/{petId}/archive': { post: tagged('petId') },
      '/users/{userId}/archive': { post: tagged('userId') },
    });
    expect(result).toEqual([
      'archivePet                   POST   /pets/{petId}/archive',
      'archiveUser                  POST   /users/{userId}/archive',
    ]);
  });

  it('singularises compound and sibilant resources', () => {
    const result = names({
      '/accounts/api_keys/{id}': { get: item('id') },
      '/accounts/auth-factors/{id}': { get: item('id') },
      '/accounts/directories/{id}': { get: item('id') },
      '/accounts/email_addresses/{id}': { get: item('id') },
      '/accounts/batches/{id}': { get: item('id') },
      '/accounts/boxes/{id}': { get: item('id') },
      '/accounts/statuses/{id}': { get: item('id') },
      '/accounts/responses/{id}': { get: item('id') },
    });
    expect(result).toEqual([
      'getApiKey                    GET    /accounts/api_keys/{id}',
      'getAuthFactor                GET    /accounts/auth-factors/{id}',
      'getBatch                     GET    /accounts/batches/{id}',
      'getBox                       GET    /accounts/boxes/{id}',
      'getDirectory                 GET    /accounts/directories/{id}',
      'getEmailAddress              GET    /accounts/email_addresses/{id}',
      'getResponse                  GET    /accounts/responses/{id}',
      'getStatus                    GET    /accounts/statuses/{id}',
    ]);
  });

  it('leaves a resource that is already singular, or does not look plural, alone', () => {
    const result = names({
      '/admin/status/{id}': { get: item('id') },
      '/admin/address/{id}': { get: item('id') },
      '/admin/analysis/{id}': { get: item('id') },
      '/admin/profile/{id}': { get: item('id') },
      '/status/{id}': { get: item('id') },
    });
    expect(result).toEqual([
      'getAddress                   GET    /admin/address/{id}',
      'getAnalysis                  GET    /admin/analysis/{id}',
      'getProfile                   GET    /admin/profile/{id}',
      'getStatus                    GET    /admin/status/{id}',
      'get                          GET    /status/{id}',
    ]);
  });

  it('documents the irregular plurals it deliberately does not handle', () => {
    const result = names({
      '/admin/people/{id}': { get: item('id') },
      '/admin/children/{id}': { get: item('id') },
      '/admin/data/{id}': { get: item('id') },
    });
    expect(result).toEqual([
      'getChildren                  GET    /admin/children/{id}',
      'getData                      GET    /admin/data/{id}',
      'getPeople                    GET    /admin/people/{id}',
    ]);
  });

  it('keeps a POST a create when the literal after the parameter ends in s', () => {
    const result = names({
      '/orgs/{id}/api_keys': { post: item('id') },
      '/orders/{id}/status': { post: item('id') },
      '/items/{id}/process': { post: item('id') },
    });
    expect(result).toEqual([
      'createProcess                POST   /items/{id}/process',
      'createStatus                 POST   /orders/{id}/status',
      'createApiKeys                POST   /orgs/{id}/api_keys',
    ]);
  });

  it('names an action with no literal parent by the bare verb, and camel-cases a multi-word action', () => {
    const result = names({
      '/{id}/adopt': { post: item('id') },
      '/users/{id}/reset_password': { post: item('id') },
      '/users/{id}/Deactivate': { post: item('id') },
    });
    expect(result).toEqual([
      'deactivateUser               POST   /users/{id}/Deactivate',
      'resetPasswordUser            POST   /users/{id}/reset_password',
      'adopt                        POST   /{id}/adopt',
    ]);
  });

  it('skips API root and version markers when picking the parent of an action', () => {
    // No shared root here (`/api/v1` beside `/v2` and `/store`), so the
    // marker check alone keeps `V1` out of the names.
    const result = names({
      '/api/v1/{companyId}/sendDocument': { post: item('companyId') },
      '/api/v1/{teamId}/subscription': { post: item('teamId') },
      '/api/v1/pets/{petId}/adopt': { post: item('petId') },
      '/v2/pets/{petId}/adopt': { post: item('petId') },
      '/store/pets/{petId}/adopt': { post: item('petId') },
    });
    expect(result).toEqual([
      'adoptPet                     POST   /api/v1/pets/{petId}/adopt',
      'sendDocument                 POST   /api/v1/{companyId}/sendDocument',
      'subscription                 POST   /api/v1/{teamId}/subscription',
      'adoptPet                     POST   /store/pets/{petId}/adopt',
      'adoptPet                     POST   /v2/pets/{petId}/adopt',
    ]);
    // A tagged operation has no API root and relies on the marker check too.
    expect(names({ '/api/v1/{orgId}/sendInvite': { post: { ...item('orgId'), tags: ['invites'] } } })).toEqual([
      'sendInvite                   POST   /api/v1/{orgId}/sendInvite',
    ]);
    // A document root that carries a non-marker word (#224) is skipped whole.
    expect(
      names({
        '/wiki/rest/api/content': { get: ok },
        '/wiki/rest/api/{id}/publish': { post: item('id') },
      }),
    ).toEqual([
      'list                         GET    /wiki/rest/api/content',
      'publish                      POST   /wiki/rest/api/{id}/publish',
    ]);
  });

  it('does not repeat the parent when the action already ends with it', () => {
    const result = names({
      '/companies/verification/{id}/restart-id-verification': { post: item('id') },
      '/companies/verification/{id}/submit-playground-verification': { post: item('id') },
      '/companies/verification/{id}/restart': { post: item('id') },
    });
    expect(result).toEqual([
      'restartVerification          POST   /companies/verification/{id}/restart',
      'restartIdVerification        POST   /companies/verification/{id}/restart-id-verification',
      'submitPlaygroundVerification POST   /companies/verification/{id}/submit-playground-verification',
    ]);
  });

  it('keeps an operationId unchanged when a singular fallback name collides with it', () => {
    const { services } = extractOperations({
      '/store/pets/{id}': { get: item('id') },
      '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
    } as Parameters<typeof extractOperations>[0]);
    const ops = services.flatMap((s) => s.operations);
    const explicit = ops.find((op) => op.path === '/store/featured/{id}')!;
    const fallback = ops.find((op) => op.path === '/store/pets/{id}')!;

    expect(explicit.name).toBe('getPet');
    expect(fallback.name).not.toBe('getPet');
    // Nothing in `/store/pets/{id}` tells it from `/store/featured/{id}`, so
    // the fallback keeps the plural it had before singularisation.
    expect(fallback.name).toBe('getPets');
    expect(new Set(ops.map((op) => op.name)).size).toBe(ops.length);
  });

  it('still tells two colliding operationIds apart when a fallback joins their group', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { services } = extractOperations({
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'get_pet' } },
        '/store/rescues/{id}': { get: { ...item('id'), operationId: 'getPet' } },
        '/store/pets/{id}': { get: item('id') },
      } as Parameters<typeof extractOperations>[0]);
      const ops = services.flatMap((s) => s.operations);

      expect(new Set(ops.map((op) => op.name)).size).toBe(3);
      expect(ops.find((op) => op.path === '/store/pets/{id}')!.name).not.toBe('getPet');
      // The reused operationId is numbered with a warning (#227); the fallback
      // takes its plural rather than a third number.
      expect(Object.fromEntries(ops.map((op) => [op.path, op.name]))).toEqual({
        '/store/featured/{id}': 'getPet',
        '/store/rescues/{id}': 'getPet2',
        '/store/pets/{id}': 'getPets',
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps every name unique with two operationIds and two fallbacks in one group', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { services } = extractOperations({
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'get_pet' } },
        '/store/rescues/{id}': { get: { ...item('id'), operationId: 'getPet' } },
        '/store/pets/{id}': { get: item('id') },
        '/store/shelter/pets/{id}': { get: item('id') },
      } as Parameters<typeof extractOperations>[0]);
      const ops = services.flatMap((s) => s.operations);

      expect(new Set(ops.map((op) => op.name)).size).toBe(4);
      for (const op of ops.filter((o) => o.path.endsWith('pets/{id}'))) expect(op.name).not.toBe('getPet');
      // The deeper path context separates `/store/shelter/pets/{id}` on its
      // own; only the fallback with nothing to add takes the plural.
      expect(Object.fromEntries(ops.map((op) => [op.path, op.name]))).toEqual({
        '/store/featured/{id}': 'getPet',
        '/store/rescues/{id}': 'getPet2',
        '/store/pets/{id}': 'getPets',
        '/store/shelter/pets/{id}': 'getPetShelter',
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('numbers the second of two colliding operationIds with a warning, as #227 does', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { services } = extractOperations({
        '/store/pets/{id}': { get: { ...item('id'), operationId: 'getPet' } },
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
      } as Parameters<typeof extractOperations>[0]);
      const opNames = services.flatMap((s) => s.operations).map((op) => op.name);
      expect(new Set(opNames).size).toBe(2);
      // The lexically first path keeps the name, whatever the document order.
      expect(opNames.sort()).toEqual(['getPet', 'getPet2']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/both take the name "getPet" from their operationId/);
    } finally {
      warn.mockRestore();
    }
  });

  it('prefers the plural a fallback had before singularisation over a numeric suffix, whatever the order', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const explicitFirst = {
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
        '/store/pets/{id}': { get: item('id') },
      };
      const fallbackFirst = {
        '/store/pets/{id}': { get: item('id') },
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
      };
      const expected = [
        'getPet                       GET    /store/featured/{id}',
        'getPets                      GET    /store/pets/{id}',
      ];
      expect(names(explicitFirst)).toEqual(expected);
      expect(names(fallbackFirst)).toEqual(expected);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('shares the plural between PUT and PATCH on one path', () => {
    expect(
      names({
        '/store/featured/{id}': { put: { ...item('id'), operationId: 'updatePet' } },
        '/store/pets/{id}': { put: item('id'), patch: item('id') },
      }),
    ).toEqual([
      'updatePet                    PUT    /store/featured/{id}',
      'updatePets                   PATCH  /store/pets/{id}',
      'updatePets                   PUT    /store/pets/{id}',
    ]);
  });

  it('never needs the plural for two fallbacks: their paths tell them apart', () => {
    expect(
      names({
        '/store/pets/{id}': { get: item('id') },
        '/store/cats/{id}': { get: item('id') },
      }),
    ).toEqual([
      'getCat                       GET    /store/cats/{id}',
      'getPet                       GET    /store/pets/{id}',
    ]);
  });

  it('falls back to a numeric suffix when the plural is taken as well', () => {
    expect(
      names({
        '/store/featured/{id}': { get: { ...item('id'), operationId: 'getPet' } },
        '/store/all/{id}': { get: { ...item('id'), operationId: 'getPets' } },
        '/store/pets/{id}': { get: item('id') },
      }),
    ).toEqual([
      'getPets                      GET    /store/all/{id}',
      'getPet                       GET    /store/featured/{id}',
      'getPet2                      GET    /store/pets/{id}',
    ]);
  });

  it('numbers an action next to an operationId of the same name: a verb has no plural', () => {
    expect(
      names({
        '/store/featured/{id}': { post: { ...item('id'), operationId: 'adoptPet' } },
        '/store/pets/{id}/adopt': { post: item('id') },
      }),
    ).toEqual([
      'adoptPet                     POST   /store/featured/{id}',
      'adoptPet2                    POST   /store/pets/{id}/adopt',
    ]);
  });

  it('qualifies two colliding actions by what sets their paths apart, never by repeating the verb', () => {
    // The deeper path context of the parent, not of the action segment.
    expect(
      names({
        '/shop/pets/{id}/adopt': { post: item('id') },
        '/shop/rescue/pets/{id}/adopt': { post: item('id') },
      }),
    ).toEqual([
      'adoptPet                     POST   /shop/pets/{id}/adopt',
      'adoptPetRescue               POST   /shop/rescue/pets/{id}/adopt',
    ]);
    // Under an API root (#224) the parameters tell the paths apart (#227);
    // one every path carries, `petId`, adds nothing (#258).
    expect(
      names({
        '/api/v1/pets/{petId}/adopt': { post: item('petId') },
        '/api/v1/{orgId}/pets/{petId}/adopt': { post: item('petId') },
      }),
    ).toEqual([
      'adoptPet                     POST   /api/v1/pets/{petId}/adopt',
      'adoptPetByOrgId              POST   /api/v1/{orgId}/pets/{petId}/adopt',
    ]);
  });

  it('meets a tenant-scoped item in one service under an API root, with no repeated word and no version', () => {
    const { services } = extractOperations({
      '/api/v1/pets/{petId}': { get: item('petId') },
      '/api/v1/{orgId}/pets/{petId}': { get: item('petId') },
    } as Parameters<typeof extractOperations>[0]);
    // `petId` is on both paths, so only `orgId` qualifies (#258).
    expect(services.flatMap((s) => s.operations.map((op) => `${s.name}.${op.name} ${op.path}`)).sort()).toEqual([
      'Pets.get /api/v1/pets/{petId}',
      'Pets.getByOrgId /api/v1/{orgId}/pets/{petId}',
    ]);
  });

  it('keeps an all-caps resource one word when singularised', () => {
    const result = names({
      '/store/DIRECTORIES/{id}': { get: item('id') },
      '/store/ADDRESSES/{id}': { get: item('id') },
      '/store/PETS/{id}': { get: item('id') },
      '/store/Policies/{id}': { get: item('id') },
    });
    expect(result).toEqual([
      'getAddress                   GET    /store/ADDRESSES/{id}',
      'getDirectory                 GET    /store/DIRECTORIES/{id}',
      'getPet                       GET    /store/PETS/{id}',
      'getPolicy                    GET    /store/Policies/{id}',
    ]);
  });

  it('is not consulted for an operation with an operationId', () => {
    const paths = {
      '/store/pets/{petId}': { get: { ...item('petId'), operationId: 'fetchPets' } },
      '/store/pets/{petId}/adopt': { post: { ...item('petId'), operationId: 'createAdoption' } },
    };
    expect(names(paths)).toEqual([
      'fetchPets                    GET    /store/pets/{petId}',
      'createAdoption               POST   /store/pets/{petId}/adopt',
    ]);

    const { services } = extractOperations(paths, (id) => `${id}_v2`);
    const transformed = services.flatMap((s) => s.operations).map((o) => o.name);
    expect(transformed.sort()).toEqual(['createAdoption_v2', 'fetchPets_v2']);
  });
});

/**
 * Custom-method paths (issue #269): an action written after a colon on the
 * segment it acts on, `/pets/{petId}:adopt`, is named exactly like the same
 * action written with a slash. Every reading of the path splits the segment
 * the same way, so the verb never lands inside a `By<Param>` qualifier.
 */
describe('custom-method paths (issue #269)', () => {
  const json = {
    responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } },
  };
  const jsonItem = (name: string) => ({ ...json, ...idParam(name) });

  it('names the issue repro: a custom method on an item is the verb plus its singular parent', () => {
    const result = names({
      '/v1/pets/{petId}:adopt': { post: jsonItem('petId') },
      '/v1/pets/{petId}:archive': { post: jsonItem('petId') },
      '/v1/pets/{petId}/feed': { post: jsonItem('petId') },
    });
    expect(result).toMatchInlineSnapshot(`
      [
        "feedPet                      POST   /v1/pets/{petId}/feed",
        "adoptPet                     POST   /v1/pets/{petId}:adopt",
        "archivePet                   POST   /v1/pets/{petId}:archive",
      ]
    `);
  });

  it('names a tagged custom method on an item the same way, keeping the service segment as the parent', () => {
    expect(names({ '/pets/{petId}:adopt': { post: { ...jsonItem('petId'), tags: ['pets'] } } })).toEqual([
      'adoptPet                     POST   /pets/{petId}:adopt',
    ]);
  });

  it('names the service from the collection a custom method is written on, and reads it like the slash form', () => {
    const paths = { '/v1/pets:batchGet': { post: json }, '/v1/pets': { get: json } };
    const { services } = extractOperations(paths as Parameters<typeof extractOperations>[0]);
    expect(services.map((s) => s.name)).toEqual(['Pets']);
    expect(names(paths)).toEqual([
      'list                         GET    /v1/pets',
      'createBatchGet               POST   /v1/pets:batchGet',
    ]);
  });

  it('qualifies by the parameter alone, never by the verb written after it', () => {
    expect(names({ '/pets/{petId}:history': { get: jsonItem('petId') }, '/pets/history': { get: json } })).toEqual([
      'listHistory                  GET    /pets/history',
      'listHistoryByPetId           GET    /pets/{petId}:history',
    ]);
  });

  it('reads a custom method and its slash form as the same words', () => {
    expect(
      names({ '/pets/{petId}:adopt': { post: jsonItem('petId') }, '/pets/{petId}/adopt': { post: jsonItem('petId') } }),
    ).toEqual([
      'adoptPet                     POST   /pets/{petId}/adopt',
      'adoptPet2                    POST   /pets/{petId}:adopt',
    ]);
  });
});
